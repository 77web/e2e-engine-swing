/**
 * The contract's actions and keys, turned into the agent's `perform` and
 * `keyboard` params. Pure: the engine sends what these return.
 *
 * Values typed or filled never appear in an error message here, since a
 * field may be a password.
 */

import { EngineError, KEY_NAMES, parseKey, type Key, type LocatorAction, type LocatorActionKind, type SelectOption } from 'e2e/engine';

/** The kinds the agent performs, in contract order. */
export const ACTIONS: readonly LocatorActionKind[] = [
  'tap',
  'doubleTap',
  'secondaryTap',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'focus',
  'scrollIntoView',
  'selectOption',
  'swipe',
];

/** A key as the agent reads it: the modifiers as written, and a `name` or a `char`. */
export type WireKey = { readonly modifiers: readonly string[] } & ({ readonly name: string } | { readonly char: string });

/** Params of the agent's `perform`. `node` is undefined for a swipe of the whole screen. */
export function performParams(node: string | undefined, action: LocatorAction): Record<string, unknown> {
  if (node === undefined && action.kind !== 'swipe') {
    throw unsupported(`${action.kind} on the screen root is not supported; only swipe is`);
  }
  const params: Record<string, unknown> = node === undefined ? { action: action.kind } : { node, action: action.kind };
  switch (action.kind) {
    // `tapModifiers` is not declared, so the harness never sends modifiers on a tap.
    case 'tap':
    case 'doubleTap':
    case 'secondaryTap':
    case 'clear':
    case 'check':
    case 'uncheck':
    case 'focus':
    case 'scrollIntoView':
      return params;
    case 'fill':
      // The agent keeps every value out of logs and errors, so `sensitive` needs no branch.
      return { ...params, value: action.value };
    case 'press':
      return { ...params, key: wireKey(action.key) };
    case 'selectOption':
      return { ...params, option: wireOption(action.value) };
    case 'swipe':
      return action.momentum === undefined ? { ...params, direction: action.direction } : { ...params, direction: action.direction, momentum: action.momentum };
    default:
      throw unsupported(`${action.kind} is not supported`);
  }
}

/** Params of the agent's `keyboard` `press`. */
export function keyboardPressParams(key: Key): Record<string, unknown> {
  return { action: 'press', key: wireKey(key) };
}

/** Params of the agent's `keyboard` `type`. */
export function keyboardTypeParams(text: string, replace: boolean): Record<string, unknown> {
  return { action: 'type', text, replace };
}

/**
 * The contract's key, parsed by the contract's one parser. The harness has
 * validated it already; a key it let through that does not parse is refused
 * as the mobile engine does.
 */
export function wireKey(key: Key): WireKey {
  const parsed = parseKey(key);
  if (parsed === undefined) {
    throw unsupported(`"${key}" is not a key: press takes one key in the form [Modifier+]...Key, a named key (${KEY_NAMES.join(', ')}) or one character`);
  }
  const modifiers = [...parsed.modifiers];
  return parsed.key.kind === 'named' ? { modifiers, name: parsed.key.name } : { modifiers, char: parsed.key.char };
}

/**
 * A select option as the agent reads it: `{label}` or `{index}`. Swing items
 * have no value apart from their text, so a bare string and `{value}` both
 * match the label (the item's `toString`).
 */
function wireOption(option: SelectOption): { readonly label: string } | { readonly index: number } {
  if (typeof option === 'string') return { label: option };
  if ('index' in option && option.index !== undefined) return { index: option.index };
  if ('value' in option && option.value !== undefined) return { label: option.value };
  return { label: option.label };
}

function unsupported(message: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', message, { retryable: false });
}
