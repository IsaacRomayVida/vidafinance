// @vitest-environment node
/**
 * The local-emulator wiring must be impossible to switch on in production.
 *
 * Pinned here, from the cheapest check to the one that reads a real bundle:
 *   - the decision function says "no" to everything but a dev build with the
 *     flag set, and refuses a project id that is not demo-*;
 *   - firebase.ts, loaded with DEV off and the flag ON, initialises the real
 *     project and connects nothing; with DEV on it connects all four SDKs to
 *     127.0.0.1 and never carries production's config;
 *   - a production BUILD of firebase.ts with the flag ON contains none of the
 *     emulator code (and a dev build does, so the check can tell);
 *   - the script that guards `npm run build` finds a planted marker.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';

import { EMULATOR_DEFAULT_PROJECT, EMULATOR_HOST, EMULATOR_PORTS, resolveEmulatorConfig } from './firebaseEmulators';

const PUBLIC_V2 = process.cwd();
const read = (rel: string) => readFileSync(resolve(PUBLIC_V2, rel), 'utf8');

interface BundleCheck {
  EMULATOR_MARKERS: readonly string[];
  findEmulatorMarkers: (dir: string) => { filesScanned: number; hits: { file: string; marker: string }[] };
}
const loadBundleCheck = async (): Promise<BundleCheck> => {
  const url = pathToFileURL(resolve(PUBLIC_V2, 'scripts/check-bundle-no-emulators.mjs')).href;
  return (await import(/* @vite-ignore */ url)) as BundleCheck;
};

describe('resolveEmulatorConfig', () => {
  it('is off unless this is a dev build AND the flag is exactly "true"', () => {
    expect(resolveEmulatorConfig({ DEV: true })).toBeNull();
    expect(resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'false' })).toBeNull();
    expect(resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: '1' })).toBeNull();
    expect(resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'TRUE' })).toBeNull();
    expect(resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true' })).not.toBeNull();
  });

  it('is off in a production build whatever the flag says', () => {
    expect(resolveEmulatorConfig({ DEV: false, VITE_USE_FIREBASE_EMULATORS: 'true' })).toBeNull();
    expect(resolveEmulatorConfig({ VITE_USE_FIREBASE_EMULATORS: 'true' })).toBeNull();
    // A truthy non-boolean is not "dev": only the literal `true` Vite sets.
    expect(resolveEmulatorConfig({ DEV: 'true' as unknown as boolean, VITE_USE_FIREBASE_EMULATORS: 'true' })).toBeNull();
  });

  it('targets a demo-* project on loopback, with the ports firebase.json gives the emulators', () => {
    const config = resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true' });
    expect(config).toEqual({ projectId: EMULATOR_DEFAULT_PROJECT, host: '127.0.0.1', ports: EMULATOR_PORTS });
    expect(EMULATOR_DEFAULT_PROJECT.startsWith('demo-')).toBe(true);

    const firebaseJson = JSON.parse(read('../firebase.json')) as { emulators: Record<string, { port?: number }> };
    for (const service of ['auth', 'firestore', 'functions', 'storage'] as const) {
      expect(EMULATOR_PORTS[service], `${service} port`).toBe(firebaseJson.emulators[service].port);
    }
  });

  it('refuses a project id that is not demo-* instead of falling back to anything', () => {
    for (const projectId of ['vida-finance', 'funpay-staging', 'demo', 'Demo-x', 'demo-x/../vida-finance']) {
      expect(
        () => resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true', VITE_FIREBASE_EMULATOR_PROJECT: projectId }),
        projectId,
      ).toThrow(/demo-\*/);
    }
    expect(
      resolveEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true', VITE_FIREBASE_EMULATOR_PROJECT: 'demo-other' })
        ?.projectId,
    ).toBe('demo-other');
  });
});

describe('firebase.ts — which backend the app is initialised against', () => {
  const calls = {
    initializeApp: vi.fn((options: unknown) => ({ options })),
    initializeAppCheck: vi.fn(),
    connectAuthEmulator: vi.fn(),
    connectFirestoreEmulator: vi.fn(),
    connectFunctionsEmulator: vi.fn(),
    connectStorageEmulator: vi.fn(),
  };

  beforeEach(() => {
    vi.resetModules();
    Object.values(calls).forEach((fn) => fn.mockClear());
    vi.doMock('firebase/app', () => ({ initializeApp: calls.initializeApp }));
    vi.doMock('firebase/app-check', () => ({
      initializeAppCheck: calls.initializeAppCheck,
      ReCaptchaEnterpriseProvider: class ReCaptchaEnterpriseProvider {},
      CustomProvider: class CustomProvider {
        options: { getToken: () => Promise<{ token: string; expireTimeMillis: number }> };
        constructor(options: { getToken: () => Promise<{ token: string; expireTimeMillis: number }> }) {
          this.options = options;
        }
      },
    }));
    vi.doMock('firebase/auth', () => ({ getAuth: () => ({ kind: 'auth' }), connectAuthEmulator: calls.connectAuthEmulator }));
    vi.doMock('firebase/firestore', () => ({
      getFirestore: () => ({ kind: 'db' }),
      connectFirestoreEmulator: calls.connectFirestoreEmulator,
    }));
    vi.doMock('firebase/storage', () => ({
      getStorage: () => ({ kind: 'storage' }),
      connectStorageEmulator: calls.connectStorageEmulator,
    }));
    vi.doMock('firebase/functions', () => ({
      getFunctions: () => ({ kind: 'functions' }),
      connectFunctionsEmulator: calls.connectFunctionsEmulator,
    }));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('firebase/app');
    vi.doUnmock('firebase/app-check');
    vi.doUnmock('firebase/auth');
    vi.doUnmock('firebase/firestore');
    vi.doUnmock('firebase/storage');
    vi.doUnmock('firebase/functions');
  });

  const connects = () =>
    calls.connectAuthEmulator.mock.calls.length +
    calls.connectFirestoreEmulator.mock.calls.length +
    calls.connectFunctionsEmulator.mock.calls.length +
    calls.connectStorageEmulator.mock.calls.length;

  it('production build + flag ON: the real project, and no emulator is connected', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_USE_FIREBASE_EMULATORS', 'true');
    vi.stubEnv('VITE_RECAPTCHA_SITE_KEY', '');
    await import('./firebase');
    expect(calls.initializeApp).toHaveBeenCalledTimes(1);
    expect(calls.initializeApp.mock.calls[0][0]).toMatchObject({ projectId: 'vida-finance' });
    expect(connects()).toBe(0);
    expect(calls.initializeAppCheck).not.toHaveBeenCalled();
  });

  it('production build + flag ON + a site key: App Check is reCAPTCHA, not the emulator stand-in', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_USE_FIREBASE_EMULATORS', 'true');
    vi.stubEnv('VITE_RECAPTCHA_SITE_KEY', '6Lexample');
    await import('./firebase');
    expect(calls.initializeAppCheck).toHaveBeenCalledTimes(1);
    const options = (calls.initializeAppCheck.mock.calls[0] as unknown[])[1] as { provider: { constructor: { name: string } } };
    expect(options.provider.constructor.name).toBe('ReCaptchaEnterpriseProvider');
    expect(connects()).toBe(0);
  });

  it('dev build without the flag: unchanged — the real project, no emulator', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_USE_FIREBASE_EMULATORS', '');
    vi.stubEnv('VITE_RECAPTCHA_SITE_KEY', '');
    await import('./firebase');
    expect(calls.initializeApp.mock.calls[0][0]).toMatchObject({ projectId: 'vida-finance' });
    expect(connects()).toBe(0);
  });

  it('dev build + flag ON: a demo-* app with nothing of production in it, all four SDKs on loopback, no reCAPTCHA', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_USE_FIREBASE_EMULATORS', 'true');
    vi.stubEnv('VITE_FIREBASE_EMULATOR_PROJECT', '');
    // Even with a site key present, emulator mode must not call reCAPTCHA.
    vi.stubEnv('VITE_RECAPTCHA_SITE_KEY', '6Lexample');
    await import('./firebase');

    const options = calls.initializeApp.mock.calls[0][0] as Record<string, unknown>;
    expect(options['projectId']).toBe(EMULATOR_DEFAULT_PROJECT);
    expect(JSON.stringify(options)).not.toMatch(/vida-finance|AIza|447766605132/);

    expect(calls.connectAuthEmulator).toHaveBeenCalledWith({ kind: 'auth' }, `http://${EMULATOR_HOST}:9099`, {
      disableWarnings: true,
    });
    expect(calls.connectFirestoreEmulator).toHaveBeenCalledWith({ kind: 'db' }, EMULATOR_HOST, 8080);
    expect(calls.connectStorageEmulator).toHaveBeenCalledWith({ kind: 'storage' }, EMULATOR_HOST, 9199);
    expect(calls.connectFunctionsEmulator).toHaveBeenCalledWith({ kind: 'functions' }, EMULATOR_HOST, 5001);

    // The emulated callables refuse a request with no App Check header, so a
    // local stand-in is installed — never the reCAPTCHA provider, which calls Google.
    expect(calls.initializeAppCheck).toHaveBeenCalledTimes(1);
    const provider = (calls.initializeAppCheck.mock.calls[0] as unknown[])[1] as {
      provider: { constructor: { name: string }; options: { getToken: () => Promise<{ token: string; expireTimeMillis: number }> } };
    };
    expect(provider.provider.constructor.name).toBe('CustomProvider');
    const { token, expireTimeMillis } = await provider.provider.options.getToken();
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.emulator-only-app-check$/);
    expect(JSON.parse(atob(token.split('.')[0]))).toMatchObject({ alg: 'none' }); // unsigned: worthless outside the emulator
    expect(expireTimeMillis).toBeGreaterThan(Date.now());
  });

  it('dev build + flag ON + a real project id: refuses to start rather than connect', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_USE_FIREBASE_EMULATORS', 'true');
    vi.stubEnv('VITE_FIREBASE_EMULATOR_PROJECT', 'vida-finance');
    await expect(import('./firebase')).rejects.toThrow(/demo-\*/);
    expect(calls.initializeApp).not.toHaveBeenCalled();
    expect(connects()).toBe(0);
  });
});

describe('the bundle', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedFlag = process.env.VITE_USE_FIREBASE_EMULATORS;

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedFlag === undefined) delete process.env.VITE_USE_FIREBASE_EMULATORS;
    else process.env.VITE_USE_FIREBASE_EMULATORS = savedFlag;
  });

  /** Bundles src/lib/firebase.ts alone (the SDK left external), the way `vite build` would. */
  const bundleFirebaseModule = async (nodeEnv: 'production' | 'development'): Promise<string> => {
    // Vite decides DEV/PROD from NODE_ENV; under Vitest it is "test".
    process.env.NODE_ENV = nodeEnv;
    // The worst case: someone exports the flag in the shell that builds for production.
    process.env.VITE_USE_FIREBASE_EMULATORS = 'true';
    const result = await build({
      configFile: false,
      root: PUBLIC_V2,
      mode: nodeEnv,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: resolve(PUBLIC_V2, 'src/lib/firebase.ts'), formats: ['es'], fileName: 'firebase' },
        rollupOptions: { external: /^firebase\// },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as { output: { type: string; code?: string }[] }[];
    return outputs.flatMap((o) => o.output).map((chunk) => chunk.code ?? '').join('\n');
  };

  it('every marker the build guard looks for is really written in firebaseEmulators.ts', async () => {
    const { EMULATOR_MARKERS } = await loadBundleCheck();
    const source = read('src/lib/firebaseEmulators.ts');
    expect(EMULATOR_MARKERS.length).toBeGreaterThan(3);
    for (const marker of EMULATOR_MARKERS) expect(source, marker).toContain(marker);
  });

  it('a production build with the flag ON ships none of the emulator wiring', async () => {
    const { EMULATOR_MARKERS } = await loadBundleCheck();
    const code = await bundleFirebaseModule('production');
    // It is the real module: production's project is in it.
    expect(code).toContain('vida-finance');
    for (const marker of EMULATOR_MARKERS) expect(code, marker).not.toContain(marker);
    expect(code).not.toMatch(/connect(Auth|Firestore|Functions|Storage)Emulator/);
    expect(code).not.toMatch(/resolveEmulatorConfig|emulatorAppOptions|CustomProvider/);
    // Not even the inert leftovers: the port table, or an import of the module.
    expect(code).not.toMatch(/9099|9199|5001|firebaseEmulators/);
  }, 60_000);

  it('a dev build does contain it — so the check above is able to fail', async () => {
    const code = await bundleFirebaseModule('development');
    expect(code).toContain(EMULATOR_DEFAULT_PROJECT);
    expect(code).toMatch(/connectAuthEmulator/);
  }, 60_000);

  it('the build guard finds a planted marker, and reports a clean bundle as clean', async () => {
    const { findEmulatorMarkers } = await loadBundleCheck();
    const dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<script src="/assets/a.js"></script>');
      writeFileSync(join(dir, 'assets', 'a.js'), 'const projectId = "vida-finance";');
      expect(findEmulatorMarkers(dir)).toEqual({ filesScanned: 2, hits: [] });

      writeFileSync(join(dir, 'assets', 'b.js'), `connect("${EMULATOR_HOST}", 8080)`);
      expect(findEmulatorMarkers(dir).hits).toEqual([{ file: join('assets', 'b.js'), marker: '127.0.0.1' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`npm run build` runs the guard after the bundle is written', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toMatch(/vite build && node scripts\/check-bundle-no-emulators\.mjs$/);
  });
});
