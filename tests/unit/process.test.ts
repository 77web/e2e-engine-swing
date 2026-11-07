/**
 * `resolveJava` and `launchJvm` against a fake `java`: a shell script that
 * prints what the agent would and then behaves as each test needs.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EngineError } from 'e2e/engine';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { launchJvm, resolveJava, type SwingProcess } from '../../src/process.ts';

const TOKEN = 'f'.repeat(64);
const AGENT_LINE = `E2E_SWING_AGENT {"port":40123,"token":"${TOKEN}"}`;

const dir = mkdtempSync(path.join(tmpdir(), 'e2e-swing-process-'));
const agentJar = path.join(dir, 'agent.jar');
const appJar = path.join(dir, 'app.jar');
writeFileSync(agentJar, '');
writeFileSync(appJar, '');

const launched: SwingProcess[] = [];

afterEach(async () => {
  await Promise.all(launched.splice(0).map((jvm) => jvm.stop()));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executable(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

let scripts = 0;
function fakeJava(body: string): string {
  scripts += 1;
  return executable(path.join(dir, `java-${scripts}`), body);
}

async function launch(java: string, extra: { startTimeoutMs?: number; signal?: AbortSignal; args?: string[] } = {}): Promise<SwingProcess> {
  const jvm = await launchJvm({ java, agentJar, appJar, cwd: dir, env: { PATH: '/usr/bin:/bin' }, startTimeoutMs: 5_000, stopGraceMs: 300, ...extra });
  launched.push(jvm);
  return jvm;
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe.skipIf(process.platform === 'win32')('resolveJava', () => {
  const home = path.join(dir, 'jdk');
  const homeJava = executable(path.join(home, 'bin', 'java'), 'exit 0');
  const pathDir = path.join(dir, 'on-path');
  const pathJava = executable(path.join(pathDir, 'java'), 'exit 0');

  it('prefers the explicit option, then JAVA_HOME, then PATH', () => {
    expect(resolveJava({ java: pathJava, env: { JAVA_HOME: home, PATH: pathDir } })).toBe(pathJava);
    expect(resolveJava({ env: { JAVA_HOME: home, PATH: pathDir } })).toBe(homeJava);
    expect(resolveJava({ env: { JAVA_HOME: path.join(dir, 'missing'), PATH: `${dir}/nowhere${path.delimiter}${pathDir}` } })).toBe(pathJava);
  });

  it('reads only the given environment', () => {
    expect(() => resolveJava({ env: {} })).toThrow(/no java executable found/);
  });

  it('refuses an explicit option that is not executable', () => {
    expect(() => resolveJava({ java: appJar, env: {} })).toThrow(/not an executable/);
  });
});

describe.skipIf(process.platform === 'win32')('launchJvm', () => {
  it('reads the endpoint and passes the agent, the jar, and the app arguments', async () => {
    const argsFile = path.join(dir, 'args.txt');
    const jvm = await launch(fakeJava(`printf '%s\\n' "$@" > '${argsFile}'\necho booting\necho '${AGENT_LINE}'\nexec sleep 30`), { args: ['--demo', 'two words'] });

    expect(jvm.endpoint).toEqual({ port: 40123, token: TOKEN });
    expect(jvm.isAlive()).toBe(true);
    expect(readFileSync(argsFile, 'utf8').split('\n').slice(0, 5)).toEqual([`-javaagent:${agentJar}`, '-jar', appJar, '--demo', 'two words']);
  });

  it('keeps the app output tail without the agent line', async () => {
    const jvm = await launch(fakeJava(`echo before\necho '${AGENT_LINE}'\necho after\necho oops >&2\nexec sleep 30`));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(jvm.outputTail().split('\n').toSorted()).toEqual(['after', 'before', 'oops']);
    expect(jvm.outputTail()).not.toContain(TOKEN);
  });

  it('reports an early exit with the output tail', async () => {
    const error = await rejection(launch(fakeJava('echo "Error: Unable to access jarfile" >&2\nexit 1')));

    expect(error.code).toBe('ENGINE_FAILURE');
    expect(error.message).toMatch(/exited \(code 1\)/);
    expect(error.message).toContain('Unable to access jarfile');
  });

  it('times out when the agent never reports, and stops the JVM', async () => {
    const pidFile = path.join(dir, 'pid-timeout.txt');
    const error = await rejection(launch(fakeJava(`echo $$ > '${pidFile}'\nexec sleep 30`), { startTimeoutMs: 1_000 }));

    expect(error.code).toBe('ENGINE_FAILURE');
    expect(error.message).toMatch(/within 1000 ms/);
    expect(isRunning(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  });

  it('never quotes a malformed agent line', async () => {
    const error = await rejection(launch(fakeJava(`echo 'E2E_SWING_AGENT {"token":"${TOKEN}"'\nexec sleep 30`)));

    expect(error.message).toMatch(/malformed/);
    expect(error.message).not.toContain(TOKEN);
  });

  it('cancels on abort', async () => {
    const controller = new AbortController();
    const pending = launch(fakeJava('exec sleep 30'), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    expect((await rejection(pending)).code).toBe('CANCELLED');
  });

  it('stops with SIGTERM, any number of times', async () => {
    const jvm = await launch(fakeJava(`echo '${AGENT_LINE}'\nexec sleep 30`));

    await Promise.all([jvm.stop(), jvm.stop()]);
    await jvm.stop();
    expect(await jvm.exited).toEqual({ code: null, signal: 'SIGTERM' });
    expect(jvm.isAlive()).toBe(false);
  });

  it('falls back to SIGKILL when the JVM ignores SIGTERM', async () => {
    const jvm = await launch(fakeJava(`trap '' TERM\necho '${AGENT_LINE}'\nwhile true; do sleep 0.05; done`));

    await jvm.stop();
    expect(await jvm.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('names the build command when the agent jar is missing', async () => {
    const error = await rejection(launchJvm({ java: '/bin/sh', appJar, agentJar: path.join(dir, 'none.jar'), cwd: dir, env: {}, startTimeoutMs: 1_000 }));

    expect(error.message).toContain('npm run build:agent');
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
