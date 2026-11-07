import { describe, expect, it } from 'vitest';
import { isEngineHandle, type EngineAppDeclaration } from 'e2e/engine';
import { swing } from '../../src/index.ts';

const validate = (app: EngineAppDeclaration): void => swing().validateApp?.(app, { targetName: 'desktop' });

describe('swing()', () => {
  it('passes defineEngine validation with the package version', () => {
    const engine = swing();
    expect(isEngineHandle(engine)).toBe(true);
    expect(engine).toMatchObject({ name: 'swing', version: '0.0.0', spiVersion: 1, platform: 'swing', workers: 1 });
  });
});

describe('validateApp', () => {
  it('accepts a jar', () => {
    expect(() => validate({ appPath: 'target/app.jar' })).not.toThrow();
  });

  it.each<[string, EngineAppDeclaration]>([
    ['no appPath', {}],
    ['an appPath that is not a jar', { appPath: 'target/App.app' }],
    ['a url', { url: 'https://example.com', appPath: 'target/app.jar' }],
    ['a bundleId', { bundleId: 'com.example.app', appPath: 'target/app.jar' }],
  ])('refuses %s, naming the target', (_label, app) => {
    expect(() => validate(app)).toThrow(/target "desktop"/);
  });
});
