/**
 * The remittance ledger's pure arithmetic: centavos, calendar dates, bank
 * reference normalisation, receipt totals and aging. No Firestore, no clock —
 * every function here takes what it needs as an argument.
 */
import {
  REMITTANCE_ALERT_THRESHOLD_DAYS,
  bankReferenceDocId,
  batchFromBatchDoc,
  calendarDaysBefore,
  calendarDaysBetween,
  remittanceAlertThreshold,
  expectedFromDeductionRows,
  expectedRemittanceFields,
  isRealCalendarDate,
  lastReceivedOnOf,
  nextOverdueAlertEpoch,
  normalizeBankReference,
  overdueAlertEpochOf,
  remittanceAlertDocIds,
  pesosToCents,
  receiptIdOf,
  receiptReferenceKey,
  receivedCentsOf,
  remittanceAging,
  remittanceStatus,
  todayInMexicoCity,
} from '../remittanceLedger';

describe('remittanceStatus', () => {
  it.each([
    [170000, 0, 'expected'],
    [170000, 100000, 'partial'],
    [170000, 170000, 'received'],
    [170000, 170001, 'overpaid'],
  ])('expected %i, received %i → %s', (expected, received, status) => {
    expect(remittanceStatus(expected, received)).toBe(status);
  });

  it('converts ledger pesos to centavos without float dust', () => {
    expect(pesosToCents(1000.1)).toBe(100010);
    expect(pesosToCents(333.33)).toBe(33333);
    expect(pesosToCents(0.1 + 0.2)).toBe(30);
  });
});

describe('expectedFromDeductionRows', () => {
  it('converts each row to centavos before summing', () => {
    // 0.1 + 0.2 + 0.3 in floats is 0.6000000000000001; ten 0.1s are 0.9999999999999999.
    const rows = Array.from({ length: 10 }, () => ({ deductionAmount: 0.1 }));

    expect(expectedFromDeductionRows(rows)).toEqual({ expectedCents: 100, deductionCount: 10 });
    expect(expectedFromDeductionRows([{ deductionAmount: 1000.1 }, { deductionAmount: 333.33 }])).toEqual({
      expectedCents: 133343,
      deductionCount: 2,
    });
  });

  it('counts a row with no amount as zero rather than NaN', () => {
    expect(expectedFromDeductionRows([{}, { deductionAmount: 5 }])).toEqual({ expectedCents: 500, deductionCount: 2 });
  });
});

describe('expectedRemittanceFields', () => {
  const batch = { batchId: 'b', employerId: 'e', payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-15' };

  it('starts a new record with no receipts', () => {
    expect(expectedRemittanceFields(batch, { expectedCents: 500, deductionCount: 1 }, undefined, 'TS')).toEqual({
      ...batch,
      expectedCents: 500,
      deductionCount: 1,
      receivedCents: 0,
      status: 'expected',
      receipts: [],
      createdAt: 'TS',
      updatedAt: 'TS',
    });
  });

  it('leaves an existing record\'s receipts alone and re-derives status', () => {
    const fields = expectedRemittanceFields(
      batch,
      { expectedCents: 500, deductionCount: 1 },
      { receivedCents: 500, receipts: [{ amountCents: 500 }] },
      'TS',
    );

    expect(fields).toMatchObject({ receivedCents: 500, status: 'received' });
    expect(fields).not.toHaveProperty('receipts');
    expect(fields).not.toHaveProperty('createdAt');
  });

  it('starts a new alert cycle when a retried batch makes a settled record owe again', () => {
    const settled = { expectedCents: 500, receivedCents: 500, overdueAlertEpoch: 2 };

    expect(
      expectedRemittanceFields(batch, { expectedCents: 800, deductionCount: 2 }, settled, 'TS'),
    ).toMatchObject({ status: 'partial', overdueAlertEpoch: 3 });
    // Still settled, or a new record: the cycle is not touched.
    expect(expectedRemittanceFields(batch, { expectedCents: 500, deductionCount: 1 }, settled, 'TS')).not.toHaveProperty(
      'overdueAlertEpoch',
    );
    expect(
      expectedRemittanceFields(batch, { expectedCents: 500, deductionCount: 1 }, undefined, 'TS'),
    ).not.toHaveProperty('overdueAlertEpoch');
    // Already owing before: the same cycle.
    expect(
      expectedRemittanceFields(batch, { expectedCents: 900, deductionCount: 2 }, { expectedCents: 800, receivedCents: 0 }, 'TS'),
    ).not.toHaveProperty('overdueAlertEpoch');
  });
});

describe('overdue alert cycles', () => {
  it('reads a missing or malformed cycle as 0', () => {
    expect(overdueAlertEpochOf(undefined)).toBe(0);
    expect(overdueAlertEpochOf({ overdueAlertEpoch: 'x' })).toBe(0);
    expect(overdueAlertEpochOf({ overdueAlertEpoch: -1 })).toBe(0);
    expect(overdueAlertEpochOf({ overdueAlertEpoch: 3 })).toBe(3);
  });

  it('moves on only for settled → owing', () => {
    const settled = { expectedCents: 500, receivedCents: 500 };
    expect(nextOverdueAlertEpoch(settled, 500, 0)).toBe(1);
    expect(nextOverdueAlertEpoch({ ...settled, overdueAlertEpoch: 1 }, 500, 100)).toBe(2);
    expect(nextOverdueAlertEpoch(settled, 500, 500)).toBe(0);
    expect(nextOverdueAlertEpoch({ expectedCents: 500, receivedCents: 100 }, 500, 0)).toBe(0);
    expect(nextOverdueAlertEpoch(undefined, 500, 0)).toBe(0);
  });

  it('lists one id per threshold for a cycle', () => {
    expect(remittanceAlertDocIds('b1', 1)).toEqual([
      'remittance-overdue_e1_1d_b1',
      'remittance-overdue_e1_16d_b1',
      'remittance-overdue_e1_31d_b1',
    ]);
  });
});

describe('batchFromBatchDoc', () => {
  it('reads the identity fields, or null when one is missing', () => {
    const doc = { employerId: 'e', payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-15', status: 'completed' };

    expect(batchFromBatchDoc('b', doc)).toEqual({
      batchId: 'b',
      employerId: 'e',
      payPeriodStart: '2026-07-01',
      payPeriodEnd: '2026-07-15',
    });
    expect(batchFromBatchDoc('b', { ...doc, employerId: undefined })).toBeNull();
    expect(batchFromBatchDoc('b', undefined)).toBeNull();
  });
});

describe('isRealCalendarDate', () => {
  it.each(['2026-07-17', '2024-02-29', '2026-12-31', '2026-01-01'])('%s exists', (iso) => {
    expect(isRealCalendarDate(iso)).toBe(true);
  });

  it.each(['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-1', 'yesterday', ''])(
    '%s does not',
    (iso) => {
      expect(isRealCalendarDate(iso)).toBe(false);
    },
  );
});

describe('todayInMexicoCity', () => {
  it('is still the previous day while UTC has rolled over', () => {
    expect(todayInMexicoCity(new Date('2026-07-21T03:00:00Z'))).toBe('2026-07-20');
    expect(todayInMexicoCity(new Date('2026-07-21T05:59:59Z'))).toBe('2026-07-20');
    expect(todayInMexicoCity(new Date('2026-07-21T06:00:00Z'))).toBe('2026-07-21');
  });

  it('pads single-digit months and days, across a year boundary', () => {
    expect(todayInMexicoCity(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31');
    expect(todayInMexicoCity(new Date('2027-03-05T12:00:00Z'))).toBe('2027-03-05');
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole days, across months and leap days', () => {
    expect(calendarDaysBetween('2026-07-15', '2026-07-20')).toBe(5);
    expect(calendarDaysBetween('2026-07-20', '2026-07-15')).toBe(-5);
    expect(calendarDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });
});

describe('normalizeBankReference', () => {
  it.each([
    ['SPEI-0001', 'SPEI-0001'],
    ['  spei-0001  ', 'SPEI-0001'],
    ['Spei   0001\t abc', 'SPEI 0001 ABC'],
    ['ｓｐｅｉ-0001', 'SPEI-0001'], // full-width letters pasted from a bank PDF
  ])('%j → %j', (raw, key) => {
    expect(normalizeBankReference(raw)).toBe(key);
  });

  it('keeps punctuation: references differing by a hyphen are not merged', () => {
    expect(normalizeBankReference('SPEI-0001')).not.toBe(normalizeBankReference('SPEI0001'));
  });
});

describe('bankReferenceDocId', () => {
  it('is a stable Firestore-safe id even for references that are not', () => {
    for (const key of ['A/B', '.', '..', '__X__', 'Ñ 1']) {
      expect(bankReferenceDocId(key)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(bankReferenceDocId('SPEI-0001')).toBe(bankReferenceDocId('SPEI-0001'));
    expect(bankReferenceDocId('SPEI-0001')).not.toBe(bankReferenceDocId('SPEI-0002'));
  });
});

describe('receipts', () => {
  const receipts = [
    { receiptId: 'r1', amountCents: 100, receivedOn: '2026-07-17', bankReference: 'a 1' },
    { amountCents: 200, receivedOn: '2026-07-19', bankReference: 'B', voided: true },
    { amountCents: 300, receivedOn: '2026-07-18', bankReference: 'c', bankReferenceKey: 'STORED' },
  ];

  it('sums only receipts that have not been voided', () => {
    expect(receivedCentsOf(receipts)).toBe(400);
    expect(receivedCentsOf([])).toBe(0);
  });

  it('takes the last received date from receipts that still count', () => {
    expect(lastReceivedOnOf(receipts)).toBe('2026-07-18');
    expect(lastReceivedOnOf([receipts[1]!])).toBeNull();
  });

  it('uses the stored id, or the position for receipts booked before ids existed', () => {
    expect(receipts.map(receiptIdOf)).toEqual(['r1', 'legacy-1', 'legacy-2']);
  });

  it('uses the stored key, or normalises the reference when there is none', () => {
    expect(receipts.map(receiptReferenceKey)).toEqual(['A 1', 'B', 'STORED']);
  });
});

describe('remittanceAging', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    payPeriodEnd: '2026-07-01',
    expectedCents: 170000,
    receivedCents: 0,
    ...over,
  });

  it.each([
    // today,       daysSince, daysOverdue, overdue, bucket
    ['2026-07-01', 0, 0, false, 'current'],
    ['2026-07-08', 7, 0, false, 'current'], // last day of grace
    ['2026-07-09', 8, 1, true, 'overdue_1_15'],
    ['2026-07-23', 22, 15, true, 'overdue_1_15'],
    ['2026-07-24', 23, 16, true, 'overdue_16_30'],
    ['2026-08-07', 37, 30, true, 'overdue_16_30'],
    ['2026-08-08', 38, 31, true, 'overdue_31_plus'],
  ])('as of %s: %i days since period end, %i overdue', (today, daysSincePeriodEnd, daysOverdue, overdue, bucket) => {
    expect(remittanceAging(doc(), today)).toEqual({
      outstandingCents: 170000,
      daysSincePeriodEnd,
      daysOverdue,
      overdue,
      bucket,
    });
  });

  it('ages a partial remittance on what is still missing', () => {
    expect(remittanceAging(doc({ receivedCents: 100000 }), '2026-07-20')).toMatchObject({
      outstandingCents: 70000,
      overdue: true,
    });
  });

  it.each([
    ['received in full', 170000],
    ['overpaid', 200000],
  ])('never reports a record %s as overdue', (_label, receivedCents) => {
    expect(remittanceAging(doc({ receivedCents }), '2027-01-01')).toMatchObject({
      outstandingCents: 0,
      daysOverdue: 0,
      overdue: false,
      bucket: 'settled',
    });
  });

  it('honours a custom grace period', () => {
    expect(remittanceAging(doc(), '2026-07-09', 0)).toMatchObject({ daysOverdue: 8, overdue: true });
    expect(remittanceAging(doc(), '2026-07-09', 30)).toMatchObject({ daysOverdue: 0, overdue: false, bucket: 'current' });
  });

  it('does not call a record late when its period end cannot be read', () => {
    expect(remittanceAging(doc({ payPeriodEnd: undefined }), '2027-01-01')).toEqual({
      outstandingCents: 170000,
      daysSincePeriodEnd: null,
      daysOverdue: 0,
      overdue: false,
      bucket: 'current',
    });
    expect(remittanceAging(doc({ payPeriodEnd: '2026-02-30' }), '2027-01-01').overdue).toBe(false);
  });

  it('is not overdue before the period has ended', () => {
    expect(remittanceAging(doc(), '2026-06-25')).toMatchObject({ daysSincePeriodEnd: -6, daysOverdue: 0, overdue: false });
  });
});

describe('calendarDaysBefore', () => {
  it('steps back across month, year and leap-day boundaries', () => {
    expect(calendarDaysBefore('2026-07-20', 7)).toBe('2026-07-13');
    expect(calendarDaysBefore('2026-07-20', 0)).toBe('2026-07-20');
    expect(calendarDaysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(calendarDaysBefore('2024-03-01', 1)).toBe('2024-02-29');
    expect(calendarDaysBefore('2026-01-03', 7)).toBe('2025-12-27');
  });

  it('is the exact edge of "overdue": the cutoff date itself is the last day still in grace', () => {
    const today = '2026-07-20';
    const cutoff = calendarDaysBefore(today, 7);
    expect(remittanceAging({ expectedCents: 1, receivedCents: 0, payPeriodEnd: cutoff }, today).overdue).toBe(false);
    expect(
      remittanceAging({ expectedCents: 1, receivedCents: 0, payPeriodEnd: calendarDaysBefore(cutoff, 1) }, today).overdue,
    ).toBe(true);
  });
});

describe('remittanceAlertThreshold', () => {
  it.each([
    [0, null],
    [1, 1],
    [15, 1],
    [16, 16],
    [30, 16],
    [31, 31],
    [400, 31],
  ])('%i day(s) overdue → %s', (daysOverdue, threshold) => {
    expect(remittanceAlertThreshold(daysOverdue)).toBe(threshold);
  });

  it('has one threshold per overdue aging bucket, at its lower edge', () => {
    expect([...REMITTANCE_ALERT_THRESHOLD_DAYS]).toEqual([1, 16, 31]);
    const bucketAt = (daysOverdue: number) =>
      remittanceAging(
        { expectedCents: 1, receivedCents: 0, payPeriodEnd: '2026-01-01' },
        calendarDaysBefore('2026-01-01', -daysOverdue),
        0,
      ).bucket;
    expect(REMITTANCE_ALERT_THRESHOLD_DAYS.map(bucketAt)).toEqual(['overdue_1_15', 'overdue_16_30', 'overdue_31_plus']);
    expect(REMITTANCE_ALERT_THRESHOLD_DAYS.map((d) => bucketAt(d - 1))).toEqual(['current', 'overdue_1_15', 'overdue_16_30']);
  });
});
