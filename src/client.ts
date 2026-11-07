/**
 * Talks to the agent: one JSON object per line over loopback TCP, answered in
 * order and matched by `id`.
 *
 * Request parameters may hold a fill value, which may be a password. No error
 * or message built here quotes them: only the method name.
 */

import net from 'node:net';
import { EngineError } from 'e2e/engine';
import type { AgentEndpoint } from './process.ts';

/** Agent error codes (see `Perform.java`). */
export const AGENT_ERRORS = {
  NODE_STALE: -32001,
  NOT_ACTIONABLE: -32002,
  UNSUPPORTED: -32003,
} as const;

/** The largest response line accepted. A snapshot of a big app is a few MiB at most. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * A read can be repeated; an action may already have reached the app. The kind
 * decides what a timeout or a lost connection means.
 */
export type CallKind = 'read' | 'action';

export interface CallOptions {
  readonly kind: CallKind;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface AgentClient {
  call<T>(method: string, params: Readonly<Record<string, unknown>>, options: CallOptions): Promise<T>;
  /** Whether the connection is still open. */
  isOpen(): boolean;
  /** Closes the connection. Pending calls fail with `INVALID_STATE`. Safe to call twice. */
  close(): void;
}

export interface ConnectOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface AgentErrorBody {
  readonly code: number;
  readonly message: string;
}

interface Pending {
  readonly method: string;
  readonly kind: CallKind;
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** Connects to the agent and authenticates with the token. */
export async function connectAgent(endpoint: AgentEndpoint, options: ConnectOptions): Promise<AgentClient> {
  options.signal?.throwIfAborted();
  const socket = net.connect(endpoint.port, '127.0.0.1');
  socket.setNoDelay(true);
  const client = new Client(socket);
  try {
    await settle(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', (error) => reject(new EngineError('ENGINE_FAILURE', `could not connect to the agent: ${error.message}`, { retryable: false, cause: error })));
      }),
      { ...options, onTimeout: () => new EngineError('ENGINE_FAILURE', `could not connect to the agent within ${options.timeoutMs} ms`, { retryable: false }) },
    );
    await client.call('auth', { token: endpoint.token }, { kind: 'read', ...options }).catch((error: unknown) => {
      if (error instanceof EngineError && error.code === 'CANCELLED') throw error;
      // The agent closes the connection without a reply when the token is wrong.
      throw new EngineError('ENGINE_FAILURE', `the agent did not accept the connection: ${(error as Error).message}`, { retryable: false, cause: error });
    });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class Client implements AgentClient {
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffered: Buffer[] = [];
  #bufferedBytes = 0;
  #closed = false;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', () => this.#fail('the connection to the agent failed'));
    socket.on('close', () => this.#fail('the app exited or closed the connection to the agent'));
  }

  isOpen(): boolean {
    return !this.#closed;
  }

  close(): void {
    this.#fail('the connection to the agent was closed');
  }

  call<T>(method: string, params: Readonly<Record<string, unknown>>, options: CallOptions): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new EngineError('INVALID_STATE', `${method}: the app is not running`, { retryable: false }));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new EngineError('CANCELLED', `${method} cancelled`, { retryable: false }));
    }
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, kind: options.kind, resolve, reject });
    });
    this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return settle(response, {
      ...options,
      onTimeout: () =>
        options.kind === 'action'
          ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${method}: the app did not answer within ${options.timeoutMs} ms; the action may have run`, { retryable: false })
          : new EngineError('OPERATION_TIMEOUT', `${method}: the app did not answer within ${options.timeoutMs} ms; its event thread may be busy`, { retryable: false }),
      onAbort: () =>
        options.kind === 'action'
          ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${method} cancelled after it was sent; the action may have run`, { retryable: false })
          : new EngineError('CANCELLED', `${method} cancelled`, { retryable: false }),
      // A late answer finds no pending entry and is dropped.
      onSettle: () => this.#pending.delete(id),
    }) as Promise<T>;
  }

  #onData(chunk: Buffer): void {
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      this.#buffered.push(chunk.subarray(start, newline));
      const line = Buffer.concat(this.#buffered).toString('utf8');
      this.#buffered = [];
      this.#bufferedBytes = 0;
      start = newline + 1;
      this.#onLine(line);
      if (this.#closed) return;
    }
    if (start < chunk.length) {
      this.#buffered.push(chunk.subarray(start));
      this.#bufferedBytes += chunk.length - start;
      if (this.#bufferedBytes > MAX_RESPONSE_BYTES) this.#fail('the agent sent a response over 64 MiB', 'ENGINE_FAILURE');
    }
  }

  #onLine(line: string): void {
    let response: { id?: unknown; result?: unknown; error?: unknown };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.#fail('the agent sent a line that is not JSON', 'ENGINE_FAILURE');
      return;
    }
    if (typeof response.id !== 'number') {
      this.#fail('the agent sent a response without an id', 'ENGINE_FAILURE');
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    if (isErrorBody(response.error)) pending.reject(toEngineError(pending.method, response.error));
    else pending.resolve(response.result);
  }

  /** Closes the socket and fails every pending call. A lost action may have run before the app went away. */
  #fail(reason: string, code: 'INVALID_STATE' | 'ENGINE_FAILURE' = 'INVALID_STATE'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    for (const pending of this.#pending.values()) {
      pending.reject(
        pending.kind === 'action'
          ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${pending.method}: ${reason}; the action may have run`, { retryable: false })
          : new EngineError(code, `${pending.method}: ${reason}`, { retryable: false }),
      );
    }
    this.#pending.clear();
  }
}

function isErrorBody(value: unknown): value is AgentErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as AgentErrorBody).code === 'number' && typeof (value as AgentErrorBody).message === 'string';
}

/**
 * Maps an agent error to the contract. The agent refuses before anything
 * reaches the app, so a refusal is never `ACTION_MAY_HAVE_COMMITTED`.
 */
export function toEngineError(method: string, { code, message }: AgentErrorBody): EngineError {
  switch (code) {
    case AGENT_ERRORS.NODE_STALE:
      return new EngineError('NODE_STALE', `${method}: ${message}`, { retryable: true });
    case AGENT_ERRORS.NOT_ACTIONABLE:
      return new EngineError('NOT_ACTIONABLE', `${method}: ${message}`, { retryable: false });
    case AGENT_ERRORS.UNSUPPORTED:
      return new EngineError('UNSUPPORTED_CAPABILITY', `${method}: ${message}`, { retryable: false });
    default:
      return new EngineError('ENGINE_FAILURE', `${method}: the agent failed (${code}): ${message}`, { retryable: false });
  }
}

interface SettleOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  onTimeout(): Error;
  onAbort?(): Error;
  onSettle?(): void;
}

/** Races the work against the timeout and the signal, and always cleans up. */
async function settle<T>(work: Promise<T>, options: SettleOptions): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        if (Number.isFinite(options.timeoutMs)) timer = setTimeout(() => reject(options.onTimeout()), Math.max(0, options.timeoutMs));
        onAbort = () => reject(options.onAbort?.() ?? new EngineError('CANCELLED', 'cancelled', { retryable: false }));
        options.signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
    options.onSettle?.();
  }
}
