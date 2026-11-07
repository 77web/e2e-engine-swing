/**
 * The Swing engine manifest, built with the public `defineEngine`.
 *
 * It declares no capabilities yet: the JVM lifecycle, `observe`, `locate`, and
 * `perform` arrive with the rest of stage 1.
 */

import { createRequire } from 'node:module';
import { ConfigurationError, defineEngine, type EngineAppCheckInfo, type EngineAppDeclaration, type EngineHandle } from 'e2e/engine';

export function swing(): EngineHandle {
  return defineEngine({
    name: 'swing',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'swing',
    // Concurrent JVMs are unverified, so one target runs one worker.
    workers: 1,
    validateApp,
  });
}

/** A Swing target launches a jar: `appPath` is required, and a URL or bundle id has no meaning here. */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a swing() target launches a jar; use app.appPath`);
  }
  if (app.bundleId !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.bundleId, but a swing() target launches a jar; use app.appPath`);
  }
  if (app.appPath === undefined || !app.appPath.endsWith('.jar')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} needs app.appPath pointing at a .jar: targets: [{ engine: swing(), app: { appPath: 'target/app.jar' } }]`);
  }
}

/** This package's version. The relative path holds from both `src/` and `dist/`. */
function ownVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}
