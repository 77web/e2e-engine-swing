/**
 * Drives `swing()` the way the harness does, against the real test app:
 * init, an attempt, locate, fill, tap, the dialog, and teardown. Opt in with
 * `E2E_SWING=1`: it needs a JDK and both jars, and it opens a window.
 */

import path from 'node:path';
import { EngineError, type EngineAttemptContext, type EngineInitInfo, type LocatorExpression, type OperationContext, type SemanticNode } from 'e2e/engine';
import { afterAll, describe, expect, it } from 'vitest';
import { swing } from '../../src/index.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const PASSWORD = 'secret';

const op = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 5_000, runId: 'run', attemptId: 'a1' }) as OperationContext;
const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000 };
const testId = (value: string): LocatorExpression => ({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value, exact: true } } });
const role = (value: string, name: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value, exact: true }, name: { kind: 'string', value: name, exact: true } },
});

describe.runIf(process.env['E2E_SWING'] === '1')('swing() on the real test app', () => {
  const engine = swing();

  afterAll(async () => {
    await engine.dispose?.(cleanup);
  });

  async function one(expression: LocatorExpression): Promise<SemanticNode> {
    const nodes = await engine.locate!(expression, op());
    expect(nodes).toHaveLength(1);
    return nodes[0]!;
  }

  /** The harness polls; so does this. */
  async function eventually(expression: LocatorExpression, count: number): Promise<readonly SemanticNode[]> {
    for (let tries = 0; tries < 50; tries += 1) {
      const nodes = await engine.locate!(expression, op());
      if (nodes.length === count) return nodes;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`expected ${count} matches`);
  }

  it('signs in from fill to the dialog, and starts the next attempt fresh', async () => {
    await engine.init!({
      runId: 'run',
      targetName: 'desktop',
      projectRoot: ROOT,
      app: { appPath: 'swing-for-test/target/swing-for-test-0.1.0.jar' },
      env: process.env,
      headed: true,
      workerSlot: 0,
      signal: new AbortController().signal,
      log: () => undefined,
    } as EngineInitInfo);
    const attempt = { attemptId: 'a1', signal: new AbortController().signal } as unknown as EngineAttemptContext;
    await engine.startAttempt!(attempt);

    const snapshot = await engine.observe!(op());
    expect(snapshot.location).toBe('Swing for Test');
    expect(snapshot.viewport.width).toBeGreaterThan(0);

    await engine.perform!((await one(testId('username'))).ref, { kind: 'fill', value: 'demo', sensitive: false }, op());
    await engine.perform!((await one(testId('password'))).ref, { kind: 'fill', value: PASSWORD, sensitive: true }, op());
    await engine.perform!((await one(testId('sign-in'))).ref, { kind: 'tap' }, op());

    const [ok] = await eventually(role('button', 'OK'), 1);
    expect(JSON.stringify((await engine.observe!(op())).root)).not.toContain(PASSWORD);
    expect((await one(testId('status'))).text).toMatch(/^Signed in as demo/);

    const blocked = await engine.perform!((await one(testId('username'))).ref, { kind: 'tap' }, op()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(blocked).toBeInstanceOf(EngineError);
    expect((blocked as EngineError).code).toBe('NOT_ACTIONABLE');

    await engine.perform!(ok!.ref, { kind: 'tap' }, op());
    await eventually(role('button', 'OK'), 0);

    // A new attempt is a new JVM: the form is empty again.
    await engine.endAttempt!(cleanup);
    await engine.startAttempt!(attempt);
    expect((await one(testId('status'))).text).not.toMatch(/Signed in/);
    await engine.endAttempt!(cleanup);
  });
});
