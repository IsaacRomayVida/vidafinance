import { describe, expect, it } from 'vitest';
import {
  bankReferenceProblem,
  classifyRemittanceError,
  formatIsoDate,
  isRealCalendarDate,
  receivedOnProblem,
  todayInMexicoCity,
  voidReasonProblem,
} from './remittance';

describe('isRealCalendarDate', () => {
  it('accepts days that exist', () => {
    expect(isRealCalendarDate('2026-03-10')).toBe(true);
    expect(isRealCalendarDate('2028-02-29')).toBe(true); // leap year
  });

  it('rejects days that do not, and anything not YYYY-MM-DD', () => {
    for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-3-10', '10/03/2026', '', 'hoy']) {
      expect(isRealCalendarDate(bad), bad).toBe(false);
    }
  });
});

describe('todayInMexicoCity', () => {
  it('is still the previous day in the evening, when UTC has already rolled over', () => {
    // 03:30 UTC on the 11th is 21:30 on the 10th in Mexico City (UTC-6).
    expect(todayInMexicoCity(new Date('2026-03-11T03:30:00Z'))).toBe('2026-03-10');
    expect(todayInMexicoCity(new Date('2026-03-11T06:00:00Z'))).toBe('2026-03-11');
  });
});

describe('receivedOnProblem', () => {
  const today = '2026-03-10';
  it('mirrors the server: required, real, and not after today', () => {
    expect(receivedOnProblem('', today)).toBe('required');
    expect(receivedOnProblem('2026-02-30', today)).toBe('invalid');
    expect(receivedOnProblem('2026-03-11', today)).toBe('future');
    expect(receivedOnProblem('2026-03-10', today)).toBeNull();
    expect(receivedOnProblem('2025-12-31', today)).toBeNull();
  });
});

describe('bankReferenceProblem / voidReasonProblem', () => {
  it('measures after trimming, as the server does', () => {
    expect(bankReferenceProblem('   ')).toBe('required');
    expect(bankReferenceProblem(' SPEI-1 ')).toBeNull();
    expect(bankReferenceProblem('x'.repeat(100))).toBeNull();
    expect(bankReferenceProblem('x'.repeat(101))).toBe('too_long');

    expect(voidReasonProblem('')).toBe('required');
    expect(voidReasonProblem(' ab ')).toBe('required');
    expect(voidReasonProblem('abc')).toBeNull();
    expect(voidReasonProblem('x'.repeat(500))).toBeNull();
    expect(voidReasonProblem('x'.repeat(501))).toBe('too_long');
  });
});

describe('classifyRemittanceError', () => {
  it('tells the two duplicate-reference cases apart by details.reason', () => {
    expect(
      classifyRemittanceError({
        code: 'functions/already-exists',
        details: { reason: 'bank-reference-in-batch', batchIds: ['b1'] },
      }),
    ).toEqual({ kind: 'duplicate_in_batch' });
    expect(
      classifyRemittanceError({
        code: 'functions/already-exists',
        details: { reason: 'bank-reference-in-other-batch', batchIds: ['b2', 7, 'b3'] },
      }),
    ).toEqual({ kind: 'duplicate_in_other_batch', batchIds: ['b2', 'b3'] });
    expect(classifyRemittanceError({ code: 'functions/already-exists' })).toEqual({ kind: 'duplicate' });
  });

  it('classifies invalid-argument and not-found, and leaves the rest to friendlyError', () => {
    expect(classifyRemittanceError({ code: 'functions/invalid-argument', message: 'bad date' })).toEqual({
      kind: 'invalid',
      detail: 'bad date',
    });
    expect(classifyRemittanceError({ code: 'functions/not-found' })).toEqual({ kind: 'not_found' });
    expect(classifyRemittanceError({ code: 'functions/resource-exhausted' })).toEqual({ kind: 'other' });
    expect(classifyRemittanceError(null)).toEqual({ kind: 'other' });
    expect(classifyRemittanceError('boom')).toEqual({ kind: 'other' });
  });
});

describe('formatIsoDate', () => {
  it('formats a calendar date without shifting it into the viewer zone', () => {
    expect(formatIsoDate('2026-03-01', 'es-MX')).toMatch(/^1 mar\.? 2026$/);
    expect(formatIsoDate('2026-03-01T02:00:00.000Z', 'es-MX')).toMatch(/^1 mar\.? 2026$/);
  });

  it('degrades to the raw value or a dash', () => {
    expect(formatIsoDate(null, 'es-MX')).toBe('—');
    expect(formatIsoDate('pendiente', 'es-MX')).toBe('pendiente');
  });
});
