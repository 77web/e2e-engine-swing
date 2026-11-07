/**
 * Starts the app's JVM under the agent and stops it.
 *
 * The agent prints one line, `E2E_SWING_AGENT {"port":…,"token":"…"}`, to the
 * JVM's stdout. That line carries the token, so it never reaches a log, an
 * error, or the output tail kept for launch failures.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EngineError } from 'e2e/engine';

const AGENT_LINE_PREFIX = 'E2E_SWING_AGENT ';
/** How many lines of the app's output a launch failure quotes. */
const TAIL_LINES = 40;
/** How long `stop` waits after SIGTERM before SIGKILL. */
const DEFAULT_STOP_GRACE_MS = 3_000;

/** The agent jar `npm run build:agent` writes. The relative path holds from both `src/` and `dist/`. */
export const DEFAULT_AGENT_JAR = fileURLToPath(new URL('../agent/target/e2e-swing-agent.jar', import.meta.url));

export interface JavaLookup {
  /** An explicit `java` executable: `swing({ java })`. Wins over everything else. */
  readonly java?: string | undefined;
  /** The worker's environment (`EngineInitInfo.env`), never `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Finds the `java` executable: the explicit option, then `JAVA_HOME`, then
 * `PATH`, all read from the given environment.
 */
export function resolveJava({ java, env }: JavaLookup): string {
  if (java !== undefined) {
    if (!isExecutable(java)) {
      throw new EngineError('ENGINE_FAILURE', `swing({ java }) names ${java}, which is not an executable file`, { retryable: false });
    }
    return java;
  }
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const javaHome = env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome !== '') {
    const candidate = path.join(javaHome, 'bin', exe);
    if (isExecutable(candidate)) return candidate;
  }
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  throw new EngineError('ENGINE_FAILURE', 'no java executable found: set JAVA_HOME, put java on PATH, or pass swing({ java: "/path/to/java" })', {
    retryable: false,
  });
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  readonly java: string;
  /** Absolute path of the app jar. */
  readonly appJar: string;
  /** Absolute path of the agent jar; defaults to `DEFAULT_AGENT_JAR`. */
  readonly agentJar?: string;
  /** Arguments passed to the app after the jar. */
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** How long the agent may take to print its line. */
  readonly startTimeoutMs: number;
  readonly signal?: AbortSignal;
  /** How long `stop` waits after SIGTERM before SIGKILL. */
  readonly stopGraceMs?: number;
}

export interface AgentEndpoint {
  readonly port: number;
  readonly token: string;
}

export interface JvmExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SwingProcess {
  /** Where the agent listens. Holds the token: do not log it. */
  readonly endpoint: AgentEndpoint;
  readonly pid: number | undefined;
  /** Resolves when the JVM exits, for any reason. Never rejects. */
  readonly exited: Promise<JvmExit>;
  /** Whether the JVM is still running. */
  isAlive(): boolean;
  /** The last lines of the app's stdout and stderr, without the agent's line. */
  outputTail(): string;
  /** SIGTERM, then SIGKILL after the grace period. Safe to call any number of times. */
  stop(): Promise<void>;
}

/** Spawns `java -javaagent:<agent> -jar <app> …args` and waits for the agent's line. */
export async function launchJvm(options: LaunchOptions): Promise<SwingProcess> {
  const agentJar = options.agentJar ?? DEFAULT_AGENT_JAR;
  if (!existsSync(agentJar)) {
    throw new EngineError('ENGINE_FAILURE', `the agent jar ${agentJar} is missing; build it with: npm run build:agent`, { retryable: false });
  }
  if (!existsSync(options.appJar)) {
    throw new EngineError('ENGINE_FAILURE', `the app jar ${options.appJar} is missing`, { retryable: false });
  }
  options.signal?.throwIfAborted();

  const child = spawn(options.java, [`-javaagent:${agentJar}`, '-jar', options.appJar, ...(options.args ?? [])], {
    cwd: options.cwd,
    env: definedOnly(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = new OutputTail(TAIL_LINES);
  const exited = new Promise<JvmExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    // A spawn failure (ENOENT, EACCES) emits 'error' and never 'exit'.
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  let alive = true;
  void exited.then(() => {
    alive = false;
  });

  const endpoint = new Promise<AgentEndpoint>((resolve, reject) => {
    let seen = false;
    // Both streams are read to the end, so a chatty app never blocks on a full pipe.
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (line.startsWith(AGENT_LINE_PREFIX)) {
        if (!seen) {
          seen = true;
          const parsed = parseAgentLine(line.slice(AGENT_LINE_PREFIX.length));
          if (parsed === undefined) reject(new EngineError('ENGINE_FAILURE', 'the agent printed a malformed connection line', { retryable: false }));
          else resolve(parsed);
        }
        return;
      }
      tail.push(line);
    });
    createInterface({ input: child.stderr! }).on('line', (line) => tail.push(line));
    child.once('error', (error) => reject(new EngineError('ENGINE_FAILURE', `could not start ${options.java}: ${error.message}`, { retryable: false, cause: error })));
    void exited.then(({ code, signal }) =>
      reject(new EngineError('ENGINE_FAILURE', `the JVM exited (${describeExit(code, signal)}) before the agent reported its port${tail.describe()}`, { retryable: false })),
    );
  });

  // The race below may settle first; the JVM's later exit must not become an unhandled rejection.
  endpoint.catch(() => undefined);

  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  let stopping: Promise<void> | undefined;
  const handle: Omit<SwingProcess, 'endpoint'> = {
    pid: child.pid,
    exited,
    isAlive: () => alive,
    outputTail: () => tail.text(),
    stop: () => (stopping ??= stopChild(child, exited, stopGraceMs)),
  };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new EngineError('ENGINE_FAILURE', `the agent did not report its port within ${options.startTimeoutMs} ms${tail.describe()}`, { retryable: false })),
        options.startTimeoutMs,
      );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new EngineError('CANCELLED', 'JVM launch cancelled', { retryable: false }));
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { ...handle, endpoint: await Promise.race([endpoint, timeout, aborted]) };
  } catch (error) {
    await handle.stop();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
  }
}

function parseAgentLine(json: string): AgentEndpoint | undefined {
  try {
    const value = JSON.parse(json) as { port?: unknown; token?: unknown };
    if (typeof value.port === 'number' && Number.isInteger(value.port) && typeof value.token === 'string' && value.token !== '') {
      return { port: value.port, token: value.token };
    }
  } catch {
    // Falls through: the caller reports it without quoting the line.
  }
  return undefined;
}

async function stopChild(child: ChildProcess, exited: Promise<JvmExit>, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const graceOver = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), graceMs);
  });
  try {
    if ((await Promise.race([exited, graceOver])) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  } finally {
    clearTimeout(timer);
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`;
  if (code !== null) return `code ${code}`;
  return 'it could not start';
}

function definedOnly(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The last lines of the app's output, for explaining a launch failure. */
class OutputTail {
  readonly #lines: string[] = [];

  constructor(readonly limit: number) {}

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.limit) this.#lines.shift();
  }

  text(): string {
    return this.#lines.join('\n');
  }

  /** The tail as a suffix for an error message, or nothing when the app printed nothing. */
  describe(): string {
    return this.#lines.length === 0 ? '' : `; last output:\n${this.text()}`;
  }
}
