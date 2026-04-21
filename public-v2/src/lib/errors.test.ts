/**
 * Tests for the error normalizer. The important properties are:
 *   1. Firebase callable HttpsError codes map to stable categories
 *      (the UI branches on these).
 *   2. Network failures surface as `network`, not `generic`.
 *   3. Unknown inputs never throw and always yield a non-empty string.
 */
import { describe, expect, it } from 'vitest';
import { classifyError, friendlyError } from './errors';

describe('classifyError', () => {
  it('maps Firebase rate-limit codes to rate_limit', () => {
    expect(classifyError({ code: 'functions/resource-exhausted' })).toBe('rate_limit');
    expect(classifyError({ code: 'resource-exhausted' })).toBe('rate_limit');
  });

  it('maps other Firebase callable codes correctly', () => {
    expect(classifyError({ code: 'functions/unavailable' })).toBe('unavailable');
    expect(classifyError({ code: 'functions/unauthenticated' })).toBe('unauthenticated');
    expect(classifyError({ code: 'functions/permission-denied' })).toBe('permission_denied');
    expect(classifyError({ code: 'functions/deadline-exceeded' })).toBe('timeout');
  });

  it('detects network failures from fetch TypeError', () => {
    const err = new TypeError('Failed to fetch');
    expect(classifyError(err)).toBe('network');
  });

  it('sniffs rate-limit from plain message when no code is present', () => {
    expect(classifyError(new Error('Too many requests'))).toBe('rate_limit');
    expect(classifyError(new Error('HTTP 429'))).toBe('rate_limit');
  });

  it('falls back to generic for unknown errors', () => {
    expect(classifyError(null)).toBe('generic');
    expect(classifyError(undefined)).toBe('generic');
    expect(classifyError('some random string')).toBe('generic');
    expect(classifyError(new Error('Some unrelated error'))).toBe('generic');
  });
});

describe('friendlyError', () => {
  it('returns a non-empty string for every classification', () => {
    const samples: unknown[] = [
      { code: 'functions/resource-exhausted' },
      { code: 'functions/unavailable' },
      { code: 'functions/unauthenticated' },
      { code: 'functions/permission-denied' },
      { code: 'functions/deadline-exceeded' },
      new TypeError('Failed to fetch'),
      new Error('random'),
      null,
      undefined,
    ];
    for (const s of samples) {
      const msg = friendlyError(s);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('never throws on weird inputs', () => {
    expect(() => friendlyError(42)).not.toThrow();
    expect(() => friendlyError({ nested: { bad: Symbol('x') } })).not.toThrow();
  });
});
