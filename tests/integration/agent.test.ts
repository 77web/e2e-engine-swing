/**
 * Starts the real test app under the real agent and reads one snapshot over
 * the wire. Opt in with `E2E_SWING=1`: it needs a JDK and both jars, and it
 * opens a window. Never print the agent's stdout line: it carries the token.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.join(import.meta.dirname, '../..');
const AGENT_JAR = path.join(ROOT, 'agent/target/e2e-swing-agent.jar');
const APP_JAR = path.join(ROOT, 'swing-for-test/target/swing-for-test-0.1.0.jar');

interface RawNode {
  readonly testId?: string;
  readonly secure?: boolean;
  readonly text?: string;
  readonly value?: unknown;
  readonly children?: readonly RawNode[];
}

function flatten(nodes: readonly RawNode[]): RawNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

/** Resolves with the agent's connection details from the JVM's stdout. */
function readAgentLine(jvm: ChildProcess): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    jvm.once('error', reject);
    jvm.once('exit', (code) => reject(new Error(`JVM exited with code ${code} before the agent reported its port`)));
    createInterface({ input: jvm.stdout! }).on('line', (line) => {
      if (line.startsWith('E2E_SWING_AGENT ')) resolve(JSON.parse(line.slice('E2E_SWING_AGENT '.length)));
    });
  });
}

/** One connection speaking the agent's line-delimited JSON, a single request at a time. */
async function connect(port: number): Promise<{ call(method: string, params?: object): Promise<unknown>; close(): void }> {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  let id = 0;
  return {
    async call(method, params = {}) {
      id += 1;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      const { value, done } = await lines.next();
      if (done === true) throw new Error(`agent closed the connection during ${method}`);
      const response = JSON.parse(value) as { id: number; result?: unknown; error?: { message: string } };
      if (response.error !== undefined) throw new Error(`${method} failed: ${response.error.message}`);
      expect(response.id).toBe(id);
      return response.result;
    },
    close: () => socket.destroy(),
  };
}

describe.runIf(process.env['E2E_SWING'] === '1')('agent on the real test app', () => {
  let jvm: ChildProcess | undefined;

  afterAll(() => {
    jvm?.kill('SIGKILL');
  });

  it('authenticates and reads the sign-in form', async () => {
    for (const jar of [AGENT_JAR, APP_JAR]) {
      if (!existsSync(jar)) throw new Error(`${jar} is missing; run: npm run build:agent && npm run build:test-app`);
    }
    jvm = spawn('java', [`-javaagent:${AGENT_JAR}`, '-jar', APP_JAR], { stdio: ['ignore', 'pipe', 'ignore'] });
    const { port, token } = await readAgentLine(jvm);

    const client = await connect(port);
    try {
      await client.call('auth', { token });

      // The agent answers before the app has shown its first window.
      let nodes: RawNode[] = [];
      for (let tries = 0; tries < 100 && !nodes.some((node) => node.testId === 'username'); tries += 1) {
        const { windows } = (await client.call('snapshot')) as { windows: RawNode[] };
        nodes = flatten(windows);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(nodes.map((node) => node.testId)).toEqual(expect.arrayContaining(['username', 'password', 'sign-in', 'status']));
      const password = nodes.find((node) => node.testId === 'password');
      expect(password?.secure).toBe(true);
      expect(password).not.toHaveProperty('text');
      expect(password).not.toHaveProperty('value');
    } finally {
      client.close();
    }
  });
});
