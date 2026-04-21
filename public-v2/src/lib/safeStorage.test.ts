/**
 * Smoke tests for safeStorage — the try/catch guards around localStorage
 * that keep us working in Safari private mode / Firefox resistFingerprinting.
 *
 * These aren't exhaustive: they lock in the "never throws" contract, which
 * is the whole reason this file exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeGetItem, safeRemoveItem, safeSetItem } from './safeStorage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('safeStorage — happy path (jsdom localStorage)', () => {
  it('round-trips a value', () => {
    expect(safeSetItem('k', 'v')).toBe(true);
    expect(safeGetItem('k')).toBe('v');
    expect(safeRemoveItem('k')).toBe(true);
    expect(safeGetItem('k')).toBeNull();
  });

  it('returns null for missing keys', () => {
    expect(safeGetItem('never-set')).toBeNull();
  });
});

describe('safeStorage — storage disabled / throws', () => {
  it('safeGetItem returns null when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: localStorage disabled');
    });
    expect(safeGetItem('k')).toBeNull();
  });

  it('safeSetItem returns false when localStorage throws (e.g. quota)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(safeSetItem('k', 'v')).toBe(false);
  });

  it('safeRemoveItem returns false when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(safeRemoveItem('k')).toBe(false);
  });
});
