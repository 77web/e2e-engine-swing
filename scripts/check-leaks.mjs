#!/usr/bin/env node
/**
 * Searches everything the last e2e run wrote (`.e2e/` by default) for the
 * test password, as a whole word. Prints each hit with its file and line, and
 * exits 1 when there is one. Binary files (screenshots) are skipped: their
 * masking is stage 3's work.
 *
 *   node scripts/check-leaks.mjs [output-dir]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PASSWORD = 'secret';
const dir = path.resolve(process.argv[2] ?? '.e2e');
const pattern = new RegExp(`(?<![A-Za-z0-9_-])${PASSWORD}(?![A-Za-z0-9_-])`);
const TEXT = /\.(json|md|txt|log|xml|html|jsonl|ndjson)$/;

function* files(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile() && TEXT.test(entry.name)) yield full;
  }
}

try {
  statSync(dir);
} catch {
  console.error(`${dir} does not exist; run npm run test:e2e first`);
  process.exit(2);
}

let checked = 0;
let hits = 0;
for (const file of files(dir)) {
  checked += 1;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (!pattern.test(line)) return;
      hits += 1;
      console.log(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim().slice(0, 200)}`);
    });
}
console.log(`${checked} files checked, ${hits} hits`);
process.exit(hits === 0 ? 0 : 1);
