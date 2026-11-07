/**
 * Stage 2, work 3: key input. Starts the real test app under the real agent
 * and sends keys with `perform` `press` and the `keyboard` method. Opt in with
 * `E2E_SWING=1`: it needs a JDK and both jars, and it opens a window.
 *
 * The same steps run twice: once as launched, when the app's window is
 * usually the active window, and once on macOS after bringing Finder to the
 * front, so the window is not active and no component holds the real focus.
 * Keys must reach the app either way.
 */

import { execFileSync } from 'node:child_process';
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
  readonly text?: string;
  readonly states: readonly string[];
  readonly children: readonly RawNode[];
}

interface WireKey {
  readonly modifiers: readonly string[];
  readonly name?: string;
  readonly char?: string;
}

const read = { kind: 'read', timeoutMs: 5_000 } as const;
const action = { kind: 'action', timeoutMs: 5_000 } as const;

const named = (name: string, ...modifiers: string[]): WireKey => ({ modifiers, name });
const char = (value: string, ...modifiers: string[]): WireKey => ({ modifiers, char: value });

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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return (error as EngineError).code;
}

function keySuite(mode: 'as launched' | 'inactive'): void {
  describe(`keys, window ${mode}`, () => {
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

    const perform = (node: RawNode, kind: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      client.call('perform', { node: node.id, action: kind, ...params }, action);
    const press = (key: WireKey): Promise<unknown> => client.call('keyboard', { action: 'press', key }, action);
    const type = (text: string, replace = false): Promise<unknown> =>
      client.call('keyboard', { action: 'type', text, replace }, action);
    const text = async (testId: string): Promise<string | undefined> => byTestId(await nodes(), testId).text;

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
      if (mode === 'inactive') {
        execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
        await waitFor((all) => !byTestId(all, 'main-window').states.includes('active'));
      }
    });

    afterAll(async () => {
      client?.close();
      await jvm?.stop();
    });

    it('types into the remembered field, replaces, and deletes with Backspace', async () => {
      const found = await nodes();
      await perform(byTestId(found, 'username'), 'tap');
      await type('dem');
      expect(await text('username')).toBe('dem');
      await type('xo');
      await perform(byTestId(found, 'username'), 'press', { key: named('Backspace') });
      expect(await text('username')).toBe('demx');
      await type('demo', true);
      expect(await text('username')).toBe('demo');
    });

    it('selects all with ControlOrMeta+a', async () => {
      await press(char('a', 'ControlOrMeta'));
      await type('z');
      expect(await text('username')).toBe('z');
      await type('demo', true);
    });

    it('moves focus with Tab and Shift+Tab', async () => {
      await press(named('Tab'));
      await type(PASSWORD);
      // Back to the username field: the typed text lands there, not in the password field.
      // Some look and feels (macOS Aqua) select all on keyboard focus, so End first.
      await press(named('Tab', 'Shift'));
      await press(named('End'));
      await type('!');
      expect(await text('username')).toBe('demo!');
      await perform(byTestId(await nodes(), 'username'), 'fill', { value: 'demo' });
    });

    it('signs in with Space on the button and closes the dialog with Escape', async () => {
      await perform(byTestId(await nodes(), 'sign-in'), 'press', { key: named('Space') });
      const found = await waitFor((all) => all.some((node) => node.role === 'dialog'));
      expect(byTestId(found, 'status').text).toBe('Signed in as demo (Viewer)');

      await press(named('Escape'));
      await waitFor((all) => !all.some((node) => node.role === 'dialog'));
    });

    it('adds todos with Enter, both typed and pressed on the field', async () => {
      let found = await nodes();
      await perform(find(found, (node) => node.role === 'page tab' && node.name === 'Todos', 'Todos tab'), 'tap');
      found = await waitFor((all) => all.some((node) => node.testId === 'todo-input'));

      await perform(byTestId(found, 'todo-input'), 'tap');
      await type('first\n');
      await perform(byTestId(found, 'todo-input'), 'fill', { value: 'second' });
      await perform(byTestId(found, 'todo-input'), 'press', { key: named('Enter') });

      found = await waitFor((all) => byTestId(all, 'todo-count').text === '2 items');
      expect(byTestId(found, 'todo-list').children.map((item) => item.name)).toEqual(['first', 'second']);
      expect(byTestId(found, 'todo-input').text).toBe('');
    });

    it('moves the list selection with ArrowDown', async () => {
      let found = await nodes();
      await perform(byTestId(found, 'todo-list').children[0]!, 'tap');
      await perform(byTestId(found, 'todo-list'), 'press', { key: named('ArrowDown') });
      found = await nodes();
      expect(byTestId(found, 'todo-list').children[1]!.states).toContain('selected');
    });

    it('refuses typing where no text is accepted, and keys it cannot send', async () => {
      const found = await nodes();
      await perform(byTestId(found, 'todo-add'), 'tap');
      expect(await codeOf(type('x'))).toBe('NOT_ACTIONABLE');
      expect(await codeOf(press(named('PrintScreen')))).toBe('UNSUPPORTED_CAPABILITY');
      expect(await codeOf(press({ modifiers: ['Hyper'], name: 'Enter' }))).toBe('ENGINE_FAILURE');
    });

    it('keeps the typed password out of the app output', () => {
      expect(jvm.outputTail()).not.toContain(PASSWORD);
    });
  });
}

describe.runIf(process.env['E2E_SWING'] === '1')('agent key input', () => {
  keySuite('as launched');
  if (process.platform === 'darwin') keySuite('inactive');
});
