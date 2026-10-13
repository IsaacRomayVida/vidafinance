import { describe, expect, it } from 'vitest';
import {
  bankReferenceProblem,
  formatInstantInMexicoCity,
  formatIsoDate,
  isRealCalendarDate,
  readRemittanceRefusal,
  receivedOnProblem,
  remittanceRefusalText,
  todayInMexicoCity,
  totalsOf,
  voidReasonProblem,
  type Remittance,
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

  it('refuses a date before the batch pay period began — the start, not the end', () => {
    expect(receivedOnProblem('2026-02-28', today, '2026-03-01')).toBe('before_period');
    expect(receivedOnProblem('2026-03-01', today, '2026-03-01')).toBeNull();
    // An employer may remit before the period closes.
    expect(receivedOnProblem('2026-03-03', today, '2026-03-01')).toBeNull();
    // Like the server: no readable start date, no lower bound.
    expect(receivedOnProblem('2020-01-01', today, null)).toBeNull();
    expect(receivedOnProblem('2020-01-01', today, 'sin fecha')).toBeNull();
    // "Future" wins when both apply (a period that has not started yet).
    expect(receivedOnProblem('2026-03-11', today, '2026-03-12')).toBe('future');
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

describe('readRemittanceRefusal', () => {
  it('reads the reason and its extras from details, whatever the HTTP code', () => {
    expect(
      readRemittanceRefusal({
        code: 'functions/already-exists',
        details: { reason: 'bank-reference-in-other-batch', batchIds: ['b-1', 7, 'b-2'] },
      }),
    ).toEqual({ reason: 'bank-reference-in-other-batch', batchIds: ['b-1', 'b-2'], today: null, payPeriodStart: null, duplicate: true });
    expect(
      readRemittanceRefusal({
        code: 'functions/invalid-argument',
        message: 'receivedOn 2026-03-01 is before the pay period',
        details: { reason: 'received-on-before-pay-period', field: 'receivedOn', payPeriodStart: '2026-03-05' },
      }),
    ).toMatchObject({ reason: 'received-on-before-pay-period', payPeriodStart: '2026-03-05', duplicate: false });
    expect(
      readRemittanceRefusal({ code: 'functions/invalid-argument', details: { reason: 'received-on-future', today: '2026-03-10' } }),
    ).toMatchObject({ reason: 'received-on-future', today: '2026-03-10' });
  });

  it('has no reason for anything it has no words for', () => {
    const none = { reason: null, batchIds: [], today: null, payPeriodStart: null, duplicate: false };
    expect(readRemittanceRefusal({ code: 'functions/invalid-argument', message: 'bad date' })).toEqual(none);
    expect(readRemittanceRefusal({ code: 'functions/invalid-argument', details: { reason: 'something-new' } })).toEqual(none);
    // Not an own key of the map: must not resolve through Object.prototype.
    expect(readRemittanceRefusal({ code: 'functions/invalid-argument', details: { reason: 'constructor' } })).toEqual(none);
    expect(readRemittanceRefusal({ code: 'functions/resource-exhausted' })).toEqual(none);
    expect(readRemittanceRefusal(null)).toEqual(none);
    expect(readRemittanceRefusal('boom')).toEqual(none);
    expect(readRemittanceRefusal({ code: 'functions/already-exists' })).toEqual({ ...none, duplicate: true });
  });
});

describe('remittanceRefusalText', () => {
  const t = (key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options ?? {})}`;

  it('is null when there is no reason, so the caller falls back to the generic friendly error', () => {
    expect(remittanceRefusalText(readRemittanceRefusal({ code: 'functions/invalid-argument', message: 'English' }), t, 'es-MX')).toBeNull();
    expect(remittanceRefusalText(readRemittanceRefusal({ code: 'functions/permission-denied' }), t, 'es-MX')).toBeNull();
  });

  it('still calls an unexplained already-exists a duplicate', () => {
    expect(remittanceRefusalText(readRemittanceRefusal({ code: 'functions/already-exists' }), t, 'es-MX')).toMatch(/^remit_err_dup\|/);
  });

  it('hands the dates over formatted, never as the server wrote them', () => {
    const text = remittanceRefusalText(
      readRemittanceRefusal({
        code: 'functions/invalid-argument',
        details: { reason: 'received-on-before-pay-period', payPeriodStart: '2026-03-05' },
      }),
      t,
      'es-MX',
    );
    expect(text).toMatch(/^remit_reason_received_on_before_pay_period\|/);
    expect(text).toMatch(/"payPeriodStart":"5 mar\.? 2026"/);
  });
});

describe('totalsOf', () => {
  const r = (expectedCents: number, receivedCents: number, outstandingCents: number, overdue: boolean) =>
    ({ expectedCents, receivedCents, aging: { outstandingCents, overdue } }) as unknown as Remittance;

  it('sums the rows it is given in integer centavos, counting overdue separately', () => {
    expect(totalsOf([r(1234567, 200000, 1034567, true), r(50000, 0, 50000, false), r(10001, 10001, 0, false)])).toEqual({
      count: 3,
      expectedCents: 1294568,
      receivedCents: 210001,
      outstandingCents: 1084567,
      overdueCount: 1,
      overdueCents: 1034567,
    });
    expect(totalsOf([])).toEqual({
      count: 0, expectedCents: 0, receivedCents: 0, outstandingCents: 0, overdueCount: 0, overdueCents: 0,
    });
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

describe('formatInstantInMexicoCity', () => {
  it('shows the day it was in Mexico City, not the UTC day', () => {
    // 03:00 UTC on the 3rd is 21:00 on the 2nd in Mexico City (UTC-6).
    expect(formatInstantInMexicoCity('2026-03-03T03:00:00.000Z', 'es-MX')).toMatch(/^2 mar\.? 2026$/);
    expect(formatIsoDate('2026-03-03T03:00:00.000Z', 'es-MX')).toMatch(/^3 mar\.? 2026$/); // what the screen used to show
    expect(formatInstantInMexicoCity('2026-03-03T06:00:00.000Z', 'es-MX')).toMatch(/^3 mar\.? 2026$/);
    expect(formatInstantInMexicoCity('2026-03-03T03:00:00.000Z', 'en-US')).toBe('Mar 2, 2026');
  });

  it('degrades to the raw value or a dash', () => {
    expect(formatInstantInMexicoCity(null, 'es-MX')).toBe('—');
    expect(formatInstantInMexicoCity('pendiente', 'es-MX')).toBe('pendiente');
  });
});
