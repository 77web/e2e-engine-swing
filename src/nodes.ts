import {obj, type EngineSnapshot, type SemanticNode, OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT} from 'e2e/engine';

export interface RawNode {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly testId?: string;
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly states: readonly string[];
  readonly secure?: boolean;
  readonly text?: string;
  readonly children: readonly RawNode[];
}

const roleMap: Record<string, string> = {
  "push button": "button",
  "text": "textbox",
  "password text": "textbox",
  "check box": "checkbox",
  "combo box": "combobox",
  "page tab list": "tablist",
  "page tab": "tab",
  "frame": "window",
  "list": "listbox",
  "list item": "option",
};

export function projectWindows(windows: readonly RawNode[], revision: string): EngineSnapshot {
  const {origin, viewport} = calculateBounds(windows);

  return obj({
    root: {
      ref: {
        id: "root",
        revision
      },
      role: "screen",
      rect: {x: 0, y: 0, ...viewport },
      children: windows.flatMap((w) => project(w, revision, origin))
    },
    viewport,
    location: windows.find((w) => w.states.includes("active"))?.name ?? windows[windows.length - 1]?.name,
  });
}

function calculateBounds(windows: readonly RawNode[]) {
  const rects = windows.map((w) => w.rect).filter((r) => r !== undefined);
  if (rects.length === 0) return {origin: {x: 0, y: 0}, viewport: { width: 0, height: 0 }};

  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));

  return {
    origin: { x: left, y: top},
    viewport: { width: right - left, height: bottom - top },
  };
}

const COLLAPSIBLE_ROLES = new Set(['panel', 'layered pane', 'root pane', 'viewport', 'scroll pane', 'filler', 'icon']);

function project(raw: RawNode, revision: string, origin: {x: number, y: number}): SemanticNode[] {
  if (!raw.states.includes('showing')) return [];
  const role =  raw.role ? (roleMap[raw.role] ?? raw.role) : undefined;
  const name = trimText(raw.name || undefined, OBSERVED_NAME_LIMIT);
  const testId = usableTestId(raw.testId);
  const children = raw.children.flatMap((c) => project(c, revision, origin));
  if (name === undefined && testId === undefined && COLLAPSIBLE_ROLES.has(raw.role ?? "")) return children;

  let text = raw.secure ? undefined : raw.text;
  let value = undefined;
  if (role === "textbox" || role === "combobox") {
    value = text;
    text = undefined;
  }

  return [obj({
    ref: {
      id: raw.id,
      revision,
    },
    role,
    name,
    testId,
    text: trimText(text, OBSERVED_TEXT_LIMIT),
    value: trimText(value, OBSERVED_TEXT_LIMIT),
    rect: raw.rect && {
      x: raw.rect.x - origin.x,
      y: raw.rect.y - origin.y,
      width: raw.rect.width,
      height: raw.rect.height,
    },
    states: projectStates(raw),
    inputPurpose: raw.secure ? ('password' as const) : undefined,
    children,
  })];
}

function trimText(rawText: string|undefined, limit: number) {
  return rawText !== undefined ? rawText.substring(0, limit) : undefined;
}

/** Names the JDK gives its own components: look and feel internals and auto-generated window names. */
const JDK_INTERNAL_NAME = /^(?:null\.|ComboBox\.|ComboPopup\.|OptionPane\.|(?:frame|dialog|win)\d+$)/;
export function usableTestId(name: string | undefined): string | undefined {
  return name === undefined || JDK_INTERNAL_NAME.test(name) ? undefined : name;
}

const CHECKABLE_ROLES = new Set(['check box', 'radio button']);

function projectStates(raw: RawNode): SemanticNode['states'] {
  const states = new Set(raw.states);
  const projected = obj({
    disabled: states.has('enabled') ? undefined : true,
    selected: states.has('selected') ? true : undefined,
    focused: states.has('focused') ? true : undefined,
    pressed: states.has('pressed') ? true : undefined,
    secure: raw.secure === true ? true : undefined,
    checked: CHECKABLE_ROLES.has(raw.role ?? '') ? states.has('checked') : undefined,
    expanded: states.has('expanded') ? true : states.has('collapsed') ? false : undefined,
  });

  return Object.keys(projected).length === 0 ? undefined : projected;
}
