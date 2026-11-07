/**
 * Stage 2, work 2: the actions other than keys. Starts the real test app under
 * the real agent and drives both tabs with them. Opt in with `E2E_SWING=1`: it
 * needs a JDK and both jars, and it opens a window.
 *
 * The combo box's selected value is not in the snapshot yet (work 4), so a
 * selection is checked through the status line that signing in writes.
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

const showing = (found: readonly RawNode[]): (string | undefined)[] =>
  items(found)
    .filter((item) => item.states.includes('showing'))
    .map((item) => item.name);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return (error as EngineError).code;
}

describe.runIf(process.env['E2E_SWING'] === '1')('agent actions other than keys', () => {
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

  const perform = (node: RawNode | undefined, kind: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    client.call('perform', { ...(node === undefined ? {} : { node: node.id }), action: kind, ...params }, action);

  async function signIn(): Promise<string> {
    let found = await nodes();
    await perform(byTestId(found, 'username'), 'fill', { value: 'demo' });
    await perform(byTestId(found, 'password'), 'fill', { value: 'secret' });
    await perform(byTestId(found, 'sign-in'), 'tap');
    found = await waitFor((all) => all.some((node) => node.role === 'dialog'));
    const status = byTestId(found, 'status').text ?? '';
    await perform(
      find(found, (node) => node.role === 'push button' && node.name === 'OK', 'OK'),
      'tap',
    );
    await waitFor((all) => !all.some((node) => node.role === 'dialog'));
    return status;
  }

  beforeAll(async () => {
    jvm = await launchJvm({
      java: resolveJava({ env: process.env }),
      appJar: APP_JAR,
      cwd: ROOT,
      env: process.env,
      startTimeoutMs: 20_000,
    });
    client = await connectAgent(jvm.endpoint, { timeoutMs: 5_000 });
    await waitFor((all) => all.some((node) => node.testId === 'username'));
  });

  afterAll(async () => {
    client?.close();
    await jvm?.stop();
  });

  it('checks and unchecks, and does nothing when the state is already right', async () => {
    const remember = (found: RawNode[]): RawNode => byTestId(found, 'remember');

    await perform(remember(await nodes()), 'check');
    expect(remember(await nodes()).states).toContain('checked');
    await perform(remember(await nodes()), 'check');
    expect(remember(await nodes()).states).toContain('checked');
    await perform(remember(await nodes()), 'uncheck');
    expect(remember(await nodes()).states).not.toContain('checked');
    await perform(remember(await nodes()), 'uncheck');
    expect(remember(await nodes()).states).not.toContain('checked');

    expect(await codeOf(perform(byTestId(await nodes(), 'sign-in'), 'check'))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('selects a combo box option by label and by index', async () => {
    const found = await nodes();
    await perform(byTestId(found, 'role'), 'selectOption', { option: { label: 'Admin' } });
    await perform(byTestId(found, 'remember'), 'check');
    expect(await signIn()).toBe('Signed in as demo (Admin), remembered');

    await perform(byTestId(found, 'role'), 'selectOption', { option: { index: 1 } });
    await perform(byTestId(found, 'remember'), 'uncheck');
    expect(await signIn()).toBe('Signed in as demo (Editor)');

    expect(await codeOf(perform(byTestId(found, 'role'), 'selectOption', { option: { label: 'Owner' } }))).toBe('NOT_ACTIONABLE');
    expect(await codeOf(perform(byTestId(found, 'role'), 'selectOption', { option: { index: 3 } }))).toBe('NOT_ACTIONABLE');
    expect(await codeOf(perform(byTestId(found, 'sign-in'), 'selectOption', { option: { index: 0 } }))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('clears a text field, and focuses, double-taps, and secondary-taps without failing', async () => {
    let found = await nodes();
    await perform(byTestId(found, 'username'), 'fill', { value: 'someone' });
    await perform(byTestId(found, 'username'), 'clear');
    found = await nodes();
    expect(byTestId(found, 'username').text).toBe('');
    expect(await codeOf(perform(byTestId(found, 'sign-in'), 'clear'))).toBe('UNSUPPORTED_CAPABILITY');

    await expect(perform(byTestId(found, 'username'), 'focus')).resolves.toEqual({});
    await expect(perform(byTestId(found, 'username'), 'doubleTap')).resolves.toEqual({});
    await expect(perform(byTestId(found, 'username'), 'secondaryTap')).resolves.toEqual({});
  });

  it('swipes a list down and up, and refuses a node outside a scroll pane', async () => {
    let found = await nodes();
    await perform(find(found, (node) => node.role === 'page tab' && node.name === 'Todos', 'Todos tab'), 'tap');
    found = await waitFor((all) => all.some((node) => node.testId === 'todo-input'));
    for (let i = 1; i <= ITEM_COUNT; i += 1) {
      await perform(byTestId(found, 'todo-input'), 'fill', { value: `item ${i}` });
      await perform(byTestId(found, 'todo-add'), 'tap');
    }
    found = await waitFor((all) => byTestId(all, 'todo-count').text === `${ITEM_COUNT} items`);
    const atTop = showing(found);
    expect(atTop[0]).toBe('item 1');

    await perform(byTestId(found, 'todo-list'), 'swipe', { direction: 'down', momentum: 'none' });
    const halfDown = showing(await nodes());
    expect(halfDown[0]).not.toBe('item 1');
    expect(halfDown).toContain(atTop.at(-1));

    await perform(byTestId(found, 'todo-list'), 'swipe', { direction: 'down', momentum: 'fast' });
    expect(showing(await nodes()).at(-1)).toBe(`item ${ITEM_COUNT}`);

    await perform(byTestId(found, 'todo-list'), 'swipe', { direction: 'up', momentum: 'fast' });
    expect(showing(await nodes())[0]).toBe('item 1');

    expect(await codeOf(perform(byTestId(found, 'todo-add'), 'swipe', { direction: 'down' }))).toBe('UNSUPPORTED_CAPABILITY');
    expect(await codeOf(perform(byTestId(found, 'todo-list'), 'swipe', { direction: 'sideways' }))).toBe('ENGINE_FAILURE');
  });

  it('swipes the front window when no node is given', async () => {
    await perform(undefined, 'swipe', { direction: 'down', momentum: 'fast' });
    expect(showing(await nodes()).at(-1)).toBe(`item ${ITEM_COUNT}`);
    await perform(undefined, 'swipe', { direction: 'up', momentum: 'fast' });
    expect(showing(await nodes())[0]).toBe('item 1');
    expect(await codeOf(perform(undefined, 'tap'))).toBe('ENGINE_FAILURE');
  });

  it('scrolls a list item into view', async () => {
    const last = items(await nodes()).at(-1)!;
    expect(last.states).not.toContain('showing');
    await perform(last, 'scrollIntoView');
    expect(items(await nodes()).at(-1)!.states).toContain('showing');

    await perform(items(await nodes())[0], 'scrollIntoView');
    expect(items(await nodes())[0]!.states).toContain('showing');
  });

  it('selects a list item by label', async () => {
    const found = await nodes();
    await perform(byTestId(found, 'todo-list'), 'selectOption', { option: { label: `item ${ITEM_COUNT}` } });
    const last = items(await nodes()).at(-1)!;
    expect(last.states).toEqual(expect.arrayContaining(['selected', 'showing']));
  });
});
