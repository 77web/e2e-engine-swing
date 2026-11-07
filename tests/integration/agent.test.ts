/**
 * Starts the real test app under the real agent through `process.ts` and
 * `client.ts`, and walks the sign-in flow. Opt in with `E2E_SWING=1`: it needs
 * a JDK and both jars, and it opens a window.
 *
 * This re-checks the range of the stage 1 manual driver: fill, tap, the modal
 * dialog, refusals behind it, stale ids, and that neither the password nor the
 * token reaches the app's output.
 */

import path from 'node:path';
import { EngineError } from 'e2e/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, type AgentClient } from '../../src/client.ts';
import { launchJvm, resolveJava, type SwingProcess } from '../../src/process.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const APP_JAR = path.join(ROOT, 'swing-for-test/target/swing-for-test-0.1.0.jar');
const PASSWORD = 'secret';

interface RawNode {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly testId?: string;
  readonly secure?: boolean;
  readonly text?: string;
  readonly value?: unknown;
  readonly children: readonly RawNode[];
}

const read = { kind: 'read', timeoutMs: 5_000 } as const;
const action = { kind: 'action', timeoutMs: 5_000 } as const;

function flatten(nodes: readonly RawNode[]): RawNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function byTestId(nodes: readonly RawNode[], testId: string): RawNode {
  const node = nodes.find((candidate) => candidate.testId === testId);
  if (node === undefined) throw new Error(`no node with testId ${testId}`);
  return node;
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe.runIf(process.env['E2E_SWING'] === '1')('agent on the real test app', () => {
  let jvm: SwingProcess;
  let client: AgentClient;

  async function windows(): Promise<RawNode[]> {
    return ((await client.call('snapshot', {}, read)) as { windows: RawNode[] }).windows;
  }

  /** Polls until a snapshot satisfies `ready`: the app shows its windows after the agent answers. */
  async function waitFor(ready: (nodes: RawNode[], wins: RawNode[]) => boolean): Promise<RawNode[]> {
    for (let tries = 0; tries < 100; tries += 1) {
      const wins = await windows();
      const nodes = flatten(wins);
      if (ready(nodes, wins)) return nodes;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the expected snapshot never arrived');
  }

  const perform = (node: RawNode, kind: string, value?: string): Promise<unknown> =>
    client.call('perform', { node: node.id, action: kind, ...(value === undefined ? {} : { value }) }, action);

  beforeAll(async () => {
    jvm = await launchJvm({
      java: resolveJava({ env: process.env }),
      appJar: APP_JAR,
      cwd: ROOT,
      env: process.env,
      startTimeoutMs: 20_000,
    });
    client = await connectAgent(jvm.endpoint, { timeoutMs: 5_000 });
  });

  afterAll(async () => {
    client?.close();
    await jvm?.stop();
  });

  it('reads the sign-in form, with the password secure and valueless', async () => {
    const nodes = await waitFor((found) => found.some((node) => node.testId === 'username'));

    expect(nodes.map((node) => node.testId)).toEqual(expect.arrayContaining(['username', 'password', 'role', 'remember', 'sign-in', 'status']));
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    const password = byTestId(nodes, 'password');
    expect(password.secure).toBe(true);
    expect(password).not.toHaveProperty('text');
    expect(password).not.toHaveProperty('value');
  });

  it('refuses actions a node cannot take', async () => {
    const nodes = flatten(await windows());

    expect((await rejection(perform(byTestId(nodes, 'sign-in'), 'fill', 'x'))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await rejection(client.call('perform', { node: 'n999999', action: 'tap' }, action))).code).toBe('NODE_STALE');
    expect((await rejection(client.call('nope', {}, read))).code).toBe('ENGINE_FAILURE');
  });

  it('signs in through a modal dialog and refuses the form behind it', async () => {
    let nodes = flatten(await windows());
    await perform(byTestId(nodes, 'username'), 'fill', 'demo');
    await perform(byTestId(nodes, 'password'), 'fill', PASSWORD);

    // The tap opens a modal dialog; it must return while the dialog is open.
    const started = Date.now();
    await perform(byTestId(nodes, 'sign-in'), 'tap');
    expect(Date.now() - started).toBeLessThan(3_000);

    nodes = await waitFor((_found, wins) => wins.some((win) => win.role === 'dialog'));
    expect(nodes.some((node) => node.name === 'Welcome, demo!')).toBe(true);
    expect(byTestId(nodes, 'status').text).toMatch(/^Signed in as demo/);
    expect(JSON.stringify(nodes)).not.toContain(PASSWORD);

    const blocked = await rejection(perform(byTestId(nodes, 'username'), 'tap'));
    expect(blocked.code).toBe('NOT_ACTIONABLE');

    const ok = nodes.find((node) => node.role === 'push button' && node.name === 'OK');
    expect(ok).toBeDefined();
    await perform(ok!, 'tap');
    nodes = await waitFor((_found, wins) => !wins.some((win) => win.role === 'dialog'));

    expect((await rejection(perform(ok!, 'tap'))).code).toBe('NODE_STALE');
    await expect(perform(byTestId(nodes, 'username'), 'tap')).resolves.toEqual({});
  });

  it('keeps the password and the token out of the app output', () => {
    expect(jvm.outputTail()).not.toContain(PASSWORD);
    expect(jvm.outputTail()).not.toContain(jvm.endpoint.token);
  });

  it('answers INVALID_STATE once the app is gone', async () => {
    await jvm.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.isOpen()).toBe(false);
    expect((await rejection(windows())).code).toBe('INVALID_STATE');
  });
});
