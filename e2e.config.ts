/**
 * Runs the e2e suite (`tests/**\/*.e2e.ts`, the default) against swing-for-test.
 *
 * It loads the built engine from `dist/`, as a published package would be
 * loaded: run `npm run test:e2e`, which builds first. Both jars must exist
 * (`npm run build:agent && npm run build:test-app`).
 */

import type { E2EConfig } from 'e2e';
import { swing } from './dist/index.js';

export default {
  targets: [{ name: 'desktop', engine: swing(), app: { appPath: 'swing-for-test/target/swing-for-test-0.1.0.jar' } }],
  // Keep the traces of passing tests too.
  trace: 'on',
  // The test app accepts only demo / secret; the value is the app's, not a real credential.
  credentials: {
    demo: { username: 'demo', password: 'secret' },
  },
} satisfies E2EConfig;
