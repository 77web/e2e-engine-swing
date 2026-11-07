/**
 * The Swing engine, built with the public `defineEngine`.
 *
 * Every attempt gets a fresh JVM: `startAttempt` launches the app under the
 * agent and waits for its first window, `endAttempt` stops it. Observation,
 * location, and actions all go through the agent's snapshot ids.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ConfigurationError,
  defineEngine,
  EngineError,
  rejectUnknownOptions,
  resolveExpression,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
  type EngineInitInfo,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorActionKind,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from 'e2e/engine';
import { connectAgent, type AgentClient } from './client.ts';
import { projectWindows, type RawNode } from './nodes.ts';
import { DEFAULT_AGENT_JAR, launchJvm, resolveJava, type LaunchOptions, type SwingProcess } from './process.ts';

export interface SwingOptions {
  /** The `java` executable. Defaults to `JAVA_HOME`, then `PATH`, of the run's environment. */
  readonly java?: string;
  /** How long one launch may take, up to the app's first window. Defaults to 20 seconds. */
  readonly startTimeoutMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 20_000;
const WINDOW_POLL_MS = 100;
/** The actions the agent performs today. */
const ACTIONS: readonly LocatorActionKind[] = ['tap', 'fill'];

/** How the engine starts the app and reaches the agent; tests replace them. */
export interface SwingDependencies {
  readonly launch: (options: LaunchOptions) => Promise<SwingProcess>;
  readonly connect: typeof connectAgent;
  readonly resolveJava: typeof resolveJava;
  readonly agentJar: string;
}

const REAL: SwingDependencies = { launch: launchJvm, connect: connectAgent, resolveJava, agentJar: DEFAULT_AGENT_JAR };

export function swing(options: SwingOptions = {}): EngineHandle {
  return createSwingEngine(options, REAL);
}

/** `swing()` with its process and connection made replaceable. */
export function createSwingEngine(options: SwingOptions, deps: SwingDependencies): EngineHandle {
  rejectUnknownOptions('swing()', options, ['java', 'startTimeoutMs']);
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', `swing({ startTimeoutMs }) must be a positive number of milliseconds, got ${String(startTimeoutMs)}`);
  }

  /** What `init` resolved; kept for every attempt of this worker. */
  let launchBase: Omit<LaunchOptions, 'signal'> | undefined;
  /** The running app of the current attempt. */
  let session: { readonly jvm: SwingProcess; readonly client: AgentClient } | undefined;
  let revision = 0;

  function current(): { readonly jvm: SwingProcess; readonly client: AgentClient } {
    if (session === undefined || !session.client.isOpen()) {
      throw new EngineError('INVALID_STATE', 'the app is not running', { retryable: false });
    }
    return session;
  }

  async function snapshot(context: OperationContext): Promise<EngineSnapshot> {
    const windows = await readWindows(current().client, context.timeoutMs, context.signal);
    revision += 1;
    return projectWindows(windows, String(revision));
  }

  async function stopSession(): Promise<void> {
    const ending = session;
    session = undefined;
    if (ending === undefined) return;
    ending.client.close();
    await ending.jvm.stop();
  }

  return defineEngine({
    name: 'swing',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'swing',
    // Concurrent JVMs are unverified, so one target runs one worker.
    workers: 1,
    actions: ACTIONS,
    validateApp,

    async init(info: EngineInitInfo): Promise<void> {
      session = undefined;
      revision = 0;
      const appPath = info.app.appPath;
      if (appPath === undefined) throw new EngineError('INVALID_STATE', 'the target declares no app.appPath', { retryable: false });
      launchBase = {
        java: deps.resolveJava({ java: options.java, env: info.env }),
        agentJar: deps.agentJar,
        appJar: path.resolve(info.projectRoot, appPath),
        args: info.app.launchArguments ?? [],
        cwd: info.projectRoot,
        env: info.env,
        startTimeoutMs,
      };
    },

    async startAttempt({ signal }): Promise<void> {
      if (launchBase === undefined) throw new EngineError('INVALID_STATE', 'startAttempt before init', { retryable: false });
      await stopSession();
      // One budget covers the launch, the connection, and the first window.
      const endsAt = Date.now() + startTimeoutMs;
      const remaining = (): number => Math.max(1, endsAt - Date.now());
      const jvm = await deps.launch({ ...launchBase, signal });
      try {
        const client = await deps.connect(jvm.endpoint, { timeoutMs: remaining(), signal });
        session = { jvm, client };
        await waitForWindow(client, remaining, signal);
      } catch (error) {
        session = undefined;
        await jvm.stop();
        throw error;
      }
    },

    async endAttempt(): Promise<void> {
      await stopSession();
    },

    async dispose(): Promise<void> {
      await stopSession();
      launchBase = undefined;
    },

    observe: snapshot,

    async locate(expression, context): Promise<readonly SemanticNode[]> {
      const { root } = await snapshot(context);
      // resolveExpression walks each given node's subtree itself.
      return resolveExpression(expression, [root]);
    },

    async perform(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void> {
      const { client } = current();
      if (ref.id === 'root') {
        throw new EngineError('UNSUPPORTED_CAPABILITY', `${action.kind} on the screen root is not supported`, { retryable: false });
      }
      const params: Record<string, unknown> = { node: ref.id, action: action.kind };
      if (action.kind === 'fill') params['value'] = action.value;
      else if (action.kind !== 'tap') {
        throw new EngineError('UNSUPPORTED_CAPABILITY', `${action.kind} is not supported yet`, { retryable: false });
      }
      await client.call('perform', params, { kind: 'action', timeoutMs: context.timeoutMs, signal: context.signal });
    },
  });

  /** The agent answers before the app shows anything; wait for a showing window. */
  async function waitForWindow(client: AgentClient, remaining: () => number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const windows = await readWindows(client, remaining(), signal);
      if (windows.some((window) => window.states.includes('showing'))) return;
      if (remaining() <= WINDOW_POLL_MS) {
        throw new EngineError('ENGINE_FAILURE', `the app showed no window within ${startTimeoutMs} ms of launch`, { retryable: false });
      }
      await new Promise((resolve) => setTimeout(resolve, WINDOW_POLL_MS));
      signal.throwIfAborted();
    }
  }
}

async function readWindows(client: AgentClient, timeoutMs: number, signal?: AbortSignal): Promise<RawNode[]> {
  const result = await client.call<{ windows: RawNode[] }>('snapshot', {}, { kind: 'read', timeoutMs, ...(signal === undefined ? {} : { signal }) });
  return result.windows;
}

/** A Swing target launches a jar: `appPath` is required, and a URL or bundle id has no meaning here. */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a swing() target launches a jar; use app.appPath`);
  }
  if (app.bundleId !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.bundleId, but a swing() target launches a jar; use app.appPath`);
  }
  if (app.appPath === undefined || !app.appPath.endsWith('.jar')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} needs app.appPath pointing at a .jar: targets: [{ engine: swing(), app: { appPath: 'target/app.jar' } }]`);
  }
}

/** This package's version. The relative path holds from both `src/` and `dist/`. */
function ownVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}
