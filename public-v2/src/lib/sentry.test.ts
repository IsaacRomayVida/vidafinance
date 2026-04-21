/**
 * Smoke tests for Sentry wiring.
 *
 * The critical contract we ship today is that Sentry is OFF in production
 * until `VITE_SENTRY_DSN` is populated. These tests lock that in: calling
 * `initSentry()` without a DSN must never call `Sentry.init`, and
 * `captureError` / `setSentryUser` must be no-ops.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const captureMock = vi.fn();
const setUserMock = vi.fn();
const withScopeMock = vi.fn();

vi.mock('@sentry/react', () => ({
  init: initMock,
  captureException: captureMock,
  setUser: setUserMock,
  withScope: withScopeMock,
}));

describe('sentry — dormant when DSN is unset', () => {
  beforeEach(() => {
    initMock.mockReset();
    captureMock.mockReset();
    setUserMock.mockReset();
    vi.resetModules();
    vi.stubEnv('VITE_SENTRY_DSN', '');
  });

  it('initSentry does not call Sentry.init when DSN is empty', async () => {
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('captureError is a no-op before init', async () => {
    const { captureError } = await import('./sentry');
    captureError(new Error('boom'));
    expect(captureMock).not.toHaveBeenCalled();
    expect(withScopeMock).not.toHaveBeenCalled();
  });

  it('setSentryUser is a no-op before init', async () => {
    const { setSentryUser } = await import('./sentry');
    setSentryUser('uid-1', 'employee');
    expect(setUserMock).not.toHaveBeenCalled();
  });
});
