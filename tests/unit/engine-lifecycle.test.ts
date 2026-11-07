/**
 * The engine's lifecycle, observation, location, and actions against a fake
 * JVM and a fake agent that answer with the captured samples.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EngineError, type EngineAttemptContext, type EngineHandle, type EngineInitInfo, type LocatorExpression, type OperationContext } from 'e2e/engine';
import { describe, expect, it } from 'vitest';
import type { AgentClient, CallOptions } from '../../src/client.ts';
import { ACTIONS } from '../../src/actions.ts';
import { createSwingEngine, swing, type SwingDependencies } from '../../src/engine.ts';
import type { RawNode } from '../../src/nodes.ts';
import type { LaunchOptions, SwingProcess } from '../../src/process.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const sample = (name: string): RawNode[] => (JSON.parse(readFileSync(path.join(ROOT, `agent/samples/${name}.json`), 'utf8')) as { windows: RawNode[] }).windows;
const INITIAL = sample('initial');

interface Call {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly options: CallOptions;
}

interface Fake {
  readonly deps: SwingDependencies;
  readonly launches: LaunchOptions[];
  readonly calls: Call[];
  readonly stopped: () => number;
  /** What each `snapshot` answers, in turn; the last one repeats. */
  snapshots: RawNode[][];
  /** Answers a `perform` or a `keyboard`; the default succeeds. */
  perform: (params: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

function fake(): Fake {
  const launches: LaunchOptions[] = [];
  const calls: Call[] = [];
  let stops = 0;
  const state: Fake = {
    launches,
    calls,
    stopped: () => stops,
    snapshots: [INITIAL],
    perform: async () => ({}),
    deps: {
      agentJar: '/agent.jar',
      resolveJava: ({ java }) => java ?? '/jdk/bin/java',
      launch: async (options) => {
        launches.push(options);
        let alive = true;
        const jvm: SwingProcess = {
          endpoint: { port: 1, token: 't' },
          pid: 1,
          exited: Promise.resolve({ code: 0, signal: null }),
          isAlive: () => alive,
          outputTail: () => '',
          stop: async () => {
            if (alive) stops += 1;
            alive = false;
          },
        };
        return jvm;
      },
      connect: async () => {
        let open = true;
        const client: AgentClient = {
          isOpen: () => open,
          close: () => {
            open = false;
          },
          async call<T>(method: string, params: Readonly<Record<string, unknown>>, options: CallOptions): Promise<T> {
            if (!open) throw new EngineError('INVALID_STATE', 'closed', { retryable: false });
            calls.push({ method, params, options });
            if (method === 'perform' || method === 'keyboard') return (await state.perform(params)) as T;
            const windows = state.snapshots.length > 1 ? state.snapshots.shift()! : state.snapshots[0]!;
            return { windows } as T;
          },
        };
        return client;
      },
    },
  };
  return state;
}

const initInfo = (overrides: Partial<EngineInitInfo['app']> = {}): EngineInitInfo =>
  ({
    runId: 'run',
    targetName: 'desktop',
    projectRoot: '/project',
    app: { appPath: 'target/app.jar', launchArguments: ['--demo'], ...overrides },
    env: { JAVA_HOME: '/jdk' },
    headed: true,
    workerSlot: 0,
    signal: new AbortController().signal,
    log: () => undefined,
  }) as EngineInitInfo;

const attempt = (): EngineAttemptContext => ({ attemptId: 'a1', signal: new AbortController().signal }) as unknown as EngineAttemptContext;
const op = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 4_000, runId: 'run', attemptId: 'a1' }) as OperationContext;
const cleanup = { signal: new AbortController().signal, timeoutMs: 5_000 };
const byTestId = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value, exact: true } } });

async function started(state = fake(), options = {}): Promise<{ engine: EngineHandle; state: Fake }> {
  const engine = createSwingEngine(options, state.deps);
  await engine.init!(initInfo());
  await engine.startAttempt!(attempt());
  return { engine, state };
}

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe('swing() options', () => {
  it('declares observation, location, keyboard, and the actions of the plan', () => {
    const engine = swing();
    expect([...engine.capabilities]).toEqual(expect.arrayContaining(['observation', 'actions', 'location', 'keyboard']));
    expect(engine.actions).toEqual(ACTIONS);
    expect(engine.tapModifiers).toBeFalsy();
  });

  it('refuses unknown options and a bad start timeout', () => {
    expect(() => swing({ jav: 'x' } as never)).toThrow(/jav/);
    expect(() => swing({ startTimeoutMs: 0 })).toThrow(/startTimeoutMs/);
  });
});

describe('lifecycle', () => {
  it('launches the jar from the project root with the launch arguments and the run environment', async () => {
    const { state } = await started(fake(), { java: '/custom/java', startTimeoutMs: 9_000 });

    expect(state.launches).toHaveLength(1);
    expect(state.launches[0]).toMatchObject({
      java: '/custom/java',
      agentJar: '/agent.jar',
      appJar: '/project/target/app.jar',
      args: ['--demo'],
      cwd: '/project',
      env: { JAVA_HOME: '/jdk' },
      startTimeoutMs: 9_000,
    });
  });

  it('waits for a showing window before the attempt starts', async () => {
    const state = fake();
    state.snapshots = [[], [], INITIAL];
    await started(state);

    expect(state.calls.filter((call) => call.method === 'snapshot')).toHaveLength(3);
  });

  it('fails the attempt and stops the JVM when no window shows within the budget', async () => {
    const state = fake();
    state.snapshots = [[]];
    const engine = createSwingEngine({ startTimeoutMs: 300 }, state.deps);
    await engine.init!(initInfo());
    const error = await rejection(engine.startAttempt!(attempt()));

    expect(error).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(error.message).toMatch(/no window within 300 ms/);
    expect(state.stopped()).toBe(1);
    expect((await rejection(engine.observe!(op()))).code).toBe('INVALID_STATE');
  });

  it('gives every attempt a fresh JVM and stops it at the end, idempotently', async () => {
    const { engine, state } = await started();
    await engine.endAttempt!(cleanup);
    await engine.endAttempt!(cleanup);
    expect(state.stopped()).toBe(1);
    expect((await rejection(engine.observe!(op()))).code).toBe('INVALID_STATE');

    await engine.startAttempt!(attempt());
    await engine.dispose!(cleanup);
    expect(state.launches).toHaveLength(2);
    expect(state.stopped()).toBe(2);
  });

  it('can be initialized again after dispose', async () => {
    const { engine } = await started();
    await engine.dispose!(cleanup);
    await engine.init!(initInfo());
    await engine.startAttempt!(attempt());
    await expect(engine.observe!(op())).resolves.toHaveProperty('root');
  });
});

describe('observe and locate', () => {
  it('projects the windows with a new revision each time', async () => {
    const { engine } = await started();
    const first = await engine.observe!(op());
    const second = await engine.observe!(op());

    expect(first.root.ref).toEqual({ id: 'root', revision: expect.any(String) });
    expect(second.root.ref.revision).not.toBe(first.root.ref.revision);
    expect(first.location).toBe('Swing for Test');
  });

  it('passes the operation budget to the agent', async () => {
    const { engine, state } = await started();
    await engine.observe!(op());

    expect(state.calls.at(-1)?.options).toMatchObject({ kind: 'read', timeoutMs: 4_000 });
  });

  it('locates by testId with the agent id', async () => {
    const { engine } = await started();
    const [node, ...rest] = await engine.locate!(byTestId('username'), op());

    expect(rest).toEqual([]);
    expect(node).toMatchObject({ testId: 'username', role: 'textbox' });
    expect(node!.ref.id).toMatch(/^n\d+$/);
  });
});

describe('perform', () => {
  it('sends tap and fill as actions with the agent node id', async () => {
    const { engine, state } = await started();
    const [username] = await engine.locate!(byTestId('username'), op());
    const [signIn] = await engine.locate!(byTestId('sign-in'), op());

    await engine.perform!(username!.ref, { kind: 'fill', value: 'demo', sensitive: false }, op());
    await engine.perform!(signIn!.ref, { kind: 'tap' }, op());

    const performs = state.calls.filter((call) => call.method === 'perform');
    expect(performs.map((call) => call.params)).toEqual([
      { node: username!.ref.id, action: 'fill', value: 'demo' },
      { node: signIn!.ref.id, action: 'tap' },
    ]);
    expect(performs.every((call) => call.options.kind === 'action')).toBe(true);
  });

  it('passes the agent error through', async () => {
    const { engine, state } = await started();
    state.perform = async () => {
      throw new EngineError('NODE_STALE', 'perform: the node is gone', { retryable: true });
    };

    expect(await rejection(engine.perform!({ id: 'n5', revision: '1' }, { kind: 'tap' }, op()))).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('builds the agent params of each kind', async () => {
    const { engine, state } = await started();
    const ref = { id: 'n5', revision: '1' };
    await engine.perform!(ref, { kind: 'check' }, op());
    await engine.perform!(ref, { kind: 'selectOption', value: { value: 'Admin' } }, op());
    await engine.perform!(ref, { kind: 'press', key: 'Escape' }, op());

    expect(state.calls.filter((call) => call.method === 'perform').map((call) => call.params)).toEqual([
      { node: 'n5', action: 'check' },
      { node: 'n5', action: 'selectOption', option: { label: 'Admin' } },
      { node: 'n5', action: 'press', key: { modifiers: [], name: 'Escape' } },
    ]);
  });

  it('sends a swipe on the root as the whole-screen swipe, without a node', async () => {
    const { engine, state } = await started();
    const { root } = await engine.observe!(op());
    await engine.perform!(root.ref, { kind: 'swipe', direction: 'down' }, op());

    expect(state.calls.at(-1)).toMatchObject({ method: 'perform', params: { action: 'swipe', direction: 'down' }, options: { kind: 'action' } });
    expect(state.calls.at(-1)?.params).not.toHaveProperty('node');
  });

  it('refuses another action on the root and an undeclared kind without calling the agent', async () => {
    const { engine, state } = await started();
    const before = state.calls.length;

    expect((await rejection(engine.perform!({ id: 'root', revision: '1' }, { kind: 'tap' }, op()))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await rejection(engine.perform!({ id: 'n5', revision: '1' }, { kind: 'hover' }, op()))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect(state.calls).toHaveLength(before);
  });

  it('is INVALID_STATE without a running app', async () => {
    const engine = createSwingEngine({}, fake().deps);
    await engine.init!(initInfo());

    expect((await rejection(engine.perform!({ id: 'n5', revision: '1' }, { kind: 'tap' }, op()))).code).toBe('INVALID_STATE');
  });
});

describe('keyboard', () => {
  it('sends type and press to the agent as actions', async () => {
    const { engine, state } = await started();
    await engine.keyboard!.type('demo', { replace: true }, op());
    await engine.keyboard!.press('Shift+Tab', op());

    const keyboard = state.calls.filter((call) => call.method === 'keyboard');
    expect(keyboard.map((call) => call.params)).toEqual([
      { action: 'type', text: 'demo', replace: true },
      { action: 'press', key: { modifiers: ['Shift'], name: 'Tab' } },
    ]);
    expect(keyboard.every((call) => call.options.kind === 'action' && call.options.timeoutMs === 4_000)).toBe(true);
  });

  it('passes the agent refusal through when nothing takes text', async () => {
    const { engine, state } = await started();
    state.perform = async () => {
      throw new EngineError('NOT_ACTIONABLE', 'keyboard: nothing that accepts text has focus', { retryable: false });
    };

    expect((await rejection(engine.keyboard!.type('secret', { replace: false }, op()))).code).toBe('NOT_ACTIONABLE');
  });

  it('refuses a key outside the grammar without calling the agent', async () => {
    const { engine, state } = await started();
    const before = state.calls.length;

    expect((await rejection(engine.keyboard!.press('Ctrl+a', op()))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect(state.calls).toHaveLength(before);
  });

  it('is INVALID_STATE without a running app', async () => {
    const engine = createSwingEngine({}, fake().deps);
    await engine.init!(initInfo());

    expect((await rejection(engine.keyboard!.press('Enter', op()))).code).toBe('INVALID_STATE');
  });
});
