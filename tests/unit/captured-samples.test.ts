/**
 * Samples captured from the real test app (`agent/scripts/capture-samples.mjs`), projected the way
 * `observe` projects them, against the committed tree each one reads as. A change to how the engine
 * reads a real tree shows up as a diff of `tests/fixtures/<sample>.tree.txt`, without a JVM.
 * `E2E_GOLDEN_UPDATE=1` rewrites the trees from the samples; review the diff like any other change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { projectWindows, type RawNode } from '../../src/nodes.ts';

const ROOT = path.join(import.meta.dirname, '../..');
const UPDATE = process.env['E2E_GOLDEN_UPDATE'] === '1';

/** One line per node. Geometry and ids are left out: they change with the window's position and the capture. */
function render(node: SemanticNode, depth = 0, out: string[] = []): string[] {
  const parts = [node.role ?? '(no role)'];
  if (node.name !== undefined) parts.push(JSON.stringify(node.name));
  if (node.text !== undefined && node.text !== node.name) parts.push(`text=${JSON.stringify(node.text)}`);
  if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`);
  for (const [state, on] of Object.entries(node.states ?? {})) parts.push(on ? `[${state}]` : `[${state}=false]`);
  if (node.inputPurpose !== undefined) parts.push(`purpose=${node.inputPurpose}`);
  if (node.testId !== undefined) parts.push(`#${node.testId}`);
  out.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
  for (const child of node.children ?? []) render(child, depth + 1, out);
  return out;
}

describe('captured samples', () => {
  it.each(['dialog', 'initial', 'todos'])('%s reads as its committed tree', (sample) => {
    const raw = JSON.parse(readFileSync(path.join(ROOT, `agent/samples/${sample}.json`), 'utf8')) as { windows: RawNode[] };
    const tree = `${render(projectWindows(raw.windows, 'test').root).join('\n')}\n`;

    const golden = path.join(ROOT, `tests/fixtures/${sample}.tree.txt`);
    if (UPDATE) writeFileSync(golden, tree);
    expect(tree).toBe(readFileSync(golden, 'utf8'));
  });
});
