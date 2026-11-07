/**
 * Stage 2, work 1: nodes that are not components. Starts the real test app
 * under the real agent and checks that a tab and a list item can be tapped,
 * that a list item scrolled out of view is scrolled in first, and that list
 * item ids stay put across snapshots but go stale when the item is removed.
 * Opt in with `E2E_SWING=1`: it needs a JDK and both jars, and it opens a window.
 */

import path from 'node:path';
import { EngineError } from 'e2e/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, type AgentClient } from '../../src/client.ts';
import { launchJvm, resolveJava, type SwingProcess } from '../../src/process.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const APP_JAR = path.join(ROOT, 'swing-for-test/target/swing-for-test-0.1.0.jar');
const ITEM_COUNT = 15;

interface RawNode {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly testId?: string;
  readonly text?: string;
  readonly states: readonly string[];
  readonly children: readonly RawNode[];
}

const read = { kind: 'read', timeoutMs: 5_000 } as const;
const action = { kind: 'action', timeoutMs: 5_000 } as const;

function flatten(nodes: readonly RawNode[]): RawNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function find(nodes: readonly RawNode[], match: (node: RawNode) => boolean, what: string): RawNode {
  const node = nodes.find(match);
  if (node === undefined) throw new Error(`no node: ${what}`);
  return node;
}

const byTestId = (nodes: readonly RawNode[], testId: string): RawNode =>
  find(nodes, (node) => node.testId === testId, `testId ${testId}`);

const items = (found: readonly RawNode[]): readonly RawNode[] => byTestId(found, 'todo-list').children;

describe.runIf(process.env['E2E_SWING'] === '1')('agent on nodes that are not components', () => {
  let jvm: SwingProcess;
  let client: AgentClient;

  async function nodes(): Promise<RawNode[]> {
    return flatten(((await client.call('snapshot', {}, read)) as { windows: RawNode[] }).windows);
  }

  async function waitFor(ready: (found: RawNode[]) => boolean): Promise<RawNode[]> {
    for (let tries = 0; tries < 100; tries += 1) {
      const found = await nodes();
      if (ready(found)) return found;
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

  it('switches tabs by tapping a tab', async () => {
    const found = await waitFor((all) => all.some((node) => node.testId === 'username'));
    const todos = find(found, (node) => node.role === 'page tab' && node.name === 'Todos', 'the Todos tab');

    await perform(todos, 'tap');

    const after = await waitFor((all) => all.some((node) => node.testId === 'todo-input'));
    expect(find(after, (node) => node.id === todos.id, 'the Todos tab again').states).toContain('selected');
  });

  it('keeps list item ids across snapshots', async () => {
    let found = await nodes();
    for (let i = 1; i <= ITEM_COUNT; i += 1) {
      await perform(byTestId(found, 'todo-input'), 'fill', `item ${i}`);
      await perform(byTestId(found, 'todo-add'), 'tap');
    }
    found = await waitFor((all) => byTestId(all, 'todo-count').text === `${ITEM_COUNT} items`);

    const first = items(found).map((item) => item.id);
    expect(items(found).map((item) => item.name)).toEqual(Array.from({ length: ITEM_COUNT }, (_, i) => `item ${i + 1}`));
    expect(new Set(first).size).toBe(ITEM_COUNT);
    expect(items(await nodes()).map((item) => item.id)).toEqual(first);
  });

  it('scrolls a hidden list item into view before tapping it', async () => {
    const last = items(await nodes()).at(-1)!;
    // The list shows only the first few items, so the last one starts out of view.
    expect(last.states).not.toContain('showing');

    await perform(last, 'tap');

    const after = items(await nodes()).at(-1)!;
    expect(after.id).toBe(last.id);
    expect(after.states).toEqual(expect.arrayContaining(['selected', 'showing']));
  });

  it('makes a removed item stale instead of passing its id to the next item', async () => {
    let found = await nodes();
    const [first, second] = items(found);
    await perform(first!, 'tap');
    await perform(byTestId(found, 'todo-remove'), 'tap');
    found = await waitFor((all) => byTestId(all, 'todo-count').text === `${ITEM_COUNT - 1} items`);

    const error = await perform(first!, 'tap').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe('NODE_STALE');
    const now = items(found)[0]!;
    expect(now.name).toBe(second!.name);
    expect(now.id).not.toBe(first!.id);
  });
});
