import { describe, expect, it } from 'vitest';
import { projectWindows, usableTestId, type RawNode } from '../../src/nodes.ts';

/** A node that is showing and enabled; each test sets only what it is about. */
const node = (fields: Partial<RawNode> = {}): RawNode => ({ id: 'n', states: ['showing', 'enabled'], children: [], ...fields });

describe('projectWindows', () => {
  it('uses the active window as the location, even when it is not the last', () => {
    const actual = projectWindows([
      node({ name: 'first', states: ['showing', 'enabled', 'active'] }),
      node({ name: 'last' }),
    ], 'test');
    expect(actual.location).toBe('first');
  });

  it('handles no windows', () => {
    const actual = projectWindows([], 'test');
    expect(actual.viewport).toEqual({ width: 0, height: 0 });
    expect(actual.root.children).toEqual([]);
  });

  it('drops the text of a secure node', () => {
    const actual = projectWindows([node({ role: 'password text', secure: true, text: 'this-is-secret' })], 'test');
    const field = actual.root.children?.[0];
    expect(field?.states?.secure).toBe(true);
    expect(field?.text).toBeUndefined();
    expect(field?.value).toBeUndefined();
    expect(JSON.stringify(actual)).not.toContain('this-is-secret');
  });

  it('collapses a panel with an empty name', () => {
    const actual = projectWindows([
      node({ name: 'window', children: [node({ role: 'panel', name: '', children: [node({ name: 'inner' })] })] }),
    ], 'test');
    expect(actual.root.children?.[0]?.children?.map((child) => child.name)).toEqual(['inner']);
  });

  it('cuts long names and text', () => {
    const actual = projectWindows([node({ name: 'a'.repeat(600), text: 'b'.repeat(600) })], 'test');
    expect(actual.root.children?.[0]?.name).toHaveLength(256);
    expect(actual.root.children?.[0]?.text).toHaveLength(512);
  });

  it('reports a node without the enabled state as disabled', () => {
    const actual = projectWindows([node({ states: ['showing'] })], 'test');
    expect(actual.root.children?.[0]?.states?.disabled).toBe(true);
  });
});

describe('usableTestId', () => {
  it.each([
    // Names the JDK gives its own components.
    ['null.glassPane', undefined],
    ['ComboBox.list', undefined],
    ['ComboPopup.popup', undefined],
    ['OptionPane.button', undefined],
    ['frame0', undefined],
    ['dialog12', undefined],
    ['win3', undefined],
    // Names an app gives: only a whole "frame0" is generated, so these stay.
    ['dialog1-confirm', 'dialog1-confirm'],
    ['frame2d', 'frame2d'],
    ['my-dialog0', 'my-dialog0'],
    ['username', 'username'],
    [undefined, undefined],
  ])('%s → %s', (name, expected) => {
    expect(usableTestId(name)).toBe(expected);
  });
});
