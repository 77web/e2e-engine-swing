/**
 * The client against a fake agent on loopback: authentication, matching by
 * id, error mapping, timeouts, and a connection that goes away.
 */

import net from 'node:net';
import { createInterface } from 'node:readline';
import { EngineError } from 'e2e/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgent, toEngineError, type AgentClient } from '../../src/client.ts';

const TOKEN = 'a'.repeat(64);

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

type Reply = (request: Request, socket: net.Socket) => void;

const servers: net.Server[] = [];
const clients: AgentClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function send(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

/** A fake agent: checks the token like the real one, then hands each request to `reply`. */
async function fakeAgent(reply: Reply): Promise<{ port: number; received: Request[] }> {
  const received: Request[] = [];
  const server = net.createServer((socket) => {
    let authenticated = false;
    socket.on('error', () => undefined);
    createInterface({ input: socket }).on('line', (line) => {
      const request = JSON.parse(line) as Request;
      received.push(request);
      if (!authenticated) {
        if (request.method !== 'auth' || request.params['token'] !== TOKEN) {
          socket.destroy();
          return;
        }
        authenticated = true;
        send(socket, { id: request.id, result: {} });
        return;
      }
      reply(request, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, received };
}

async function connect(port: number, token = TOKEN): Promise<AgentClient> {
  const client = await connectAgent({ port, token }, { timeoutMs: 2_000 });
  clients.push(client);
  return client;
}

const read = { kind: 'read', timeoutMs: 2_000 } as const;
const action = { kind: 'action', timeoutMs: 2_000 } as const;

async function rejection(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  return error as EngineError;
}

describe('connectAgent', () => {
  it('authenticates with the token and then calls methods', async () => {
    const agent = await fakeAgent((request, socket) => send(socket, { id: request.id, result: { windows: [] } }));
    const client = await connect(agent.port);

    await expect(client.call('snapshot', {}, read)).resolves.toEqual({ windows: [] });
    expect(agent.received.map((request) => request.method)).toEqual(['auth', 'snapshot']);
  });

  it('fails as ENGINE_FAILURE when the agent drops a wrong token, without quoting it', async () => {
    const agent = await fakeAgent(() => undefined);
    const error = await rejection(connectAgent({ port: agent.port, token: 'wrong-token' }, { timeoutMs: 2_000 }));

    expect(error.code).toBe('ENGINE_FAILURE');
    expect(error.message).not.toContain('wrong-token');
  });

  it('fails as ENGINE_FAILURE when nothing listens', async () => {
    const agent = await fakeAgent(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));

    expect((await rejection(connectAgent({ port: agent.port, token: TOKEN }, { timeoutMs: 2_000 }))).code).toBe('ENGINE_FAILURE');
  });
});

describe('call', () => {
  it('matches responses by id, even when two calls are in flight', async () => {
    const agent = await fakeAgent((request, socket) => send(socket, { id: request.id, result: request.method }));
    const client = await connect(agent.port);

    await expect(Promise.all([client.call('snapshot', {}, read), client.call('windows', {}, read)])).resolves.toEqual(['snapshot', 'windows']);
  });

  it('reads a response split across chunks and one with several lines in a chunk', async () => {
    const agent = await fakeAgent((request, socket) => {
      const line = `${JSON.stringify({ id: request.id, result: { text: 'é'.repeat(5_000) } })}\n`;
      const bytes = Buffer.from(line);
      socket.write(bytes.subarray(0, 7));
      setTimeout(() => socket.write(bytes.subarray(7)), 10);
    });
    const client = await connect(agent.port);

    await expect(client.call('snapshot', {}, read)).resolves.toEqual({ text: 'é'.repeat(5_000) });
  });

  it.each([
    [-32001, 'NODE_STALE', true],
    [-32002, 'NOT_ACTIONABLE', false],
    [-32003, 'UNSUPPORTED_CAPABILITY', false],
    [-32602, 'ENGINE_FAILURE', false],
    [-32603, 'ENGINE_FAILURE', false],
  ])('maps agent error %i to %s', async (code, expected, retryable) => {
    const agent = await fakeAgent((request, socket) => send(socket, { id: request.id, error: { code, message: 'refused' } }));
    const client = await connect(agent.port);
    const error = await rejection(client.call('perform', { node: 'n1', action: 'tap' }, action));

    expect(error).toMatchObject({ code: expected, retryable });
  });

  it('never quotes the parameters of a failed call', async () => {
    const agent = await fakeAgent((request, socket) => send(socket, { id: request.id, error: { code: -32603, message: 'perform failed' } }));
    const client = await connect(agent.port);
    const error = await rejection(client.call('perform', { node: 'n1', action: 'fill', value: 'hunter2' }, action));

    expect(`${error.message} ${String(error.cause)}`).not.toContain('hunter2');
  });

  it('times out a read as OPERATION_TIMEOUT and an action as ACTION_MAY_HAVE_COMMITTED', async () => {
    const agent = await fakeAgent(() => undefined);
    const client = await connect(agent.port);

    expect((await rejection(client.call('snapshot', {}, { kind: 'read', timeoutMs: 50 }))).code).toBe('OPERATION_TIMEOUT');
    expect((await rejection(client.call('perform', {}, { kind: 'action', timeoutMs: 50 }))).code).toBe('ACTION_MAY_HAVE_COMMITTED');
    expect(client.isOpen()).toBe(true);
  });

  it('drops a late answer to a timed-out call and answers the next one', async () => {
    let first = true;
    const agent = await fakeAgent((request, socket) => {
      const delay = first ? 150 : 0;
      first = false;
      setTimeout(() => send(socket, { id: request.id, result: request.id }), delay);
    });
    const client = await connect(agent.port);

    expect((await rejection(client.call('snapshot', {}, { kind: 'read', timeoutMs: 50 }))).code).toBe('OPERATION_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(client.call<number>('snapshot', {}, read)).resolves.toBe(3);
  });

  it('cancels on abort', async () => {
    const agent = await fakeAgent(() => undefined);
    const client = await connect(agent.port);
    const controller = new AbortController();
    const pending = client.call('snapshot', {}, { ...read, signal: controller.signal });
    controller.abort();

    expect((await rejection(pending)).code).toBe('CANCELLED');
    expect((await rejection(client.call('snapshot', {}, { ...read, signal: controller.signal }))).code).toBe('CANCELLED');
  });

  it('fails pending reads as INVALID_STATE and pending actions as ACTION_MAY_HAVE_COMMITTED when the app goes away', async () => {
    const agent = await fakeAgent((request, socket) => {
      if (request.method === 'perform') socket.destroy();
    });
    const client = await connect(agent.port);
    const reading = client.call('snapshot', {}, read);
    const acting = client.call('perform', {}, action);

    expect((await rejection(acting)).code).toBe('ACTION_MAY_HAVE_COMMITTED');
    expect((await rejection(reading)).code).toBe('INVALID_STATE');
    expect(client.isOpen()).toBe(false);
    expect((await rejection(client.call('snapshot', {}, read))).code).toBe('INVALID_STATE');
  });

  it('closes on a line that is not JSON', async () => {
    const agent = await fakeAgent((_request, socket) => socket.write('not json\n'));
    const client = await connect(agent.port);

    expect((await rejection(client.call('snapshot', {}, read))).code).toBe('ENGINE_FAILURE');
    expect(client.isOpen()).toBe(false);
  });
});

describe('toEngineError', () => {
  it('keeps the method and the agent message', () => {
    expect(toEngineError('perform', { code: -32002, message: 'a modal dialog blocks the node' }).message).toBe('perform: a modal dialog blocks the node');
  });
});
