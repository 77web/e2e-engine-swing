import { EngineError, LOCATOR_ACTION_KINDS, type LocatorAction } from 'e2e/engine';
import { describe, expect, it } from 'vitest';
import { ACTIONS, keyboardPressParams, keyboardTypeParams, performParams, wireKey } from '../../src/actions.ts';

function refusal(run: () => unknown): EngineError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    return error as EngineError;
  }
  throw new Error('expected a refusal');
}

describe('ACTIONS', () => {
  it('lists the twelve kinds of the plan, in contract order', () => {
    expect(ACTIONS).toEqual(LOCATOR_ACTION_KINDS.filter((kind) => ACTIONS.includes(kind)));
    expect(ACTIONS).toHaveLength(12);
    for (const kind of ['longPress', 'hover', 'setInputFiles', 'dragTo'] as const) expect(ACTIONS).not.toContain(kind);
  });
});

describe('performParams', () => {
  it.each<[LocatorAction, Record<string, unknown>]>([
    [{ kind: 'tap' }, {}],
    [{ kind: 'doubleTap' }, {}],
    [{ kind: 'secondaryTap' }, {}],
    [{ kind: 'clear' }, {}],
    [{ kind: 'check' }, {}],
    [{ kind: 'uncheck' }, {}],
    [{ kind: 'focus' }, {}],
    [{ kind: 'scrollIntoView' }, {}],
    [{ kind: 'fill', value: 'demo', sensitive: false }, { value: 'demo' }],
    [{ kind: 'fill', value: 'secret', sensitive: true }, { value: 'secret' }],
    [{ kind: 'press', key: 'Shift+Tab' }, { key: { modifiers: ['Shift'], name: 'Tab' } }],
    [{ kind: 'press', key: 'ControlOrMeta+a' }, { key: { modifiers: ['ControlOrMeta'], char: 'a' } }],
    [{ kind: 'selectOption', value: 'Admin' }, { option: { label: 'Admin' } }],
    [{ kind: 'selectOption', value: { label: 'Admin' } }, { option: { label: 'Admin' } }],
    [{ kind: 'selectOption', value: { value: 'Admin' } }, { option: { label: 'Admin' } }],
    [{ kind: 'selectOption', value: { index: 0 } }, { option: { index: 0 } }],
    [{ kind: 'swipe', direction: 'down' }, { direction: 'down' }],
    [{ kind: 'swipe', direction: 'up', momentum: 'fast' }, { direction: 'up', momentum: 'fast' }],
  ])('%j on a node', (action, extra) => {
    expect(performParams('n7', action)).toEqual({ node: 'n7', action: action.kind, ...extra });
  });

  it('sends a swipe of the whole screen without a node', () => {
    expect(performParams(undefined, { kind: 'swipe', direction: 'down', momentum: 'none' })).toEqual({ action: 'swipe', direction: 'down', momentum: 'none' });
  });

  it('refuses any other action on the whole screen', () => {
    expect(refusal(() => performParams(undefined, { kind: 'tap' })).code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('refuses a kind it does not declare', () => {
    expect(refusal(() => performParams('n7', { kind: 'hover' })).code).toBe('UNSUPPORTED_CAPABILITY');
    expect(refusal(() => performParams('n7', { kind: 'longPress' })).code).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('keys', () => {
  it.each([
    ['Enter', { modifiers: [], name: 'Enter' }],
    ['Escape', { modifiers: [], name: 'Escape' }],
    ['Control+Shift+F5', { modifiers: ['Control', 'Shift'], name: 'F5' }],
    ['$', { modifiers: [], char: '$' }],
    ['+', { modifiers: [], char: '+' }],
  ])('reads %s', (key, wire) => {
    expect(wireKey(key)).toEqual(wire);
  });

  it('refuses a key outside the grammar, naming it', () => {
    const error = refusal(() => wireKey('Ctrl+a'));
    expect(error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(error.message).toContain('"Ctrl+a"');
  });

  it('builds the keyboard params', () => {
    expect(keyboardPressParams('Escape')).toEqual({ action: 'press', key: { modifiers: [], name: 'Escape' } });
    expect(keyboardTypeParams('demo', true)).toEqual({ action: 'type', text: 'demo', replace: true });
  });
});
