/**
 * `remittanceOverdueCheck` — the daily alert for payroll remittances that stay
 * unpaid. Pinned here:
 *
 *  - it raises into `incident_log` (the ops Alerts page) and Slack, the two
 *    channels the other monitors already use;
 *  - ONE alert per record per threshold (1, 16, 31 days overdue) per cycle,
 *    however many times it runs — including after ops dismissed the alert;
 *  - it closes open alerts whose record is no longer overdue, and a record a
 *    void re-opened (a new cycle) can raise its thresholds again;
 *  - "today" is the Mexico City date, and the grace window is respected;
 *  - it walks every page of the ledger, up to a cap it reports loudly;
 *  - index.ts exports it and deploy.yml deploys it.
 *
 * Time is passed in (`runRemittanceOverdueCheck(db, now)`) or pinned through
 * `Date.now` for the scheduled handler; nothing here waits on a real clock.
 */
export {};

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));
jest.mock('firebase-functions', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const mockSendSlackAlert = jest.fn(async (_message: string, _severity?: string) => {});
jest.mock('../../utils/slackAlert', () => ({
  sendSlackAlert: (message: string, severity?: string) => mockSendSlackAlert(message, severity),
}));

type Doc = Record<string, unknown>;
type Collection = 'payrollRemittances' | 'incident_log';
type Filter = { field: string; op: string; value: unknown };
type Spec = {
  collection: Collection;
  filters: Filter[];
  orders: Array<{ field: string; direction: string }>;
  after: unknown[] | null;
  limit: number | null;
};

const mockStore: Record<Collection, Record<string, Doc>> = {
  payrollRemittances: {},
  incident_log: {},
};
const mockQueries: Spec[] = [];
/** Batch ids whose alert write should fail with something other than "already exists". */
const mockFailCreateFor = new Set<string>();
/** Alert ids whose resolving update should fail. */
const mockFailUpdateFor = new Set<string>();

const mockDocRef = (collection: Collection, id: string) => ({
  id,
  get: async () => {
    const entry = mockStore[collection][id];
    return { id, exists: entry !== undefined, data: () => entry };
  },
  // Like the Admin SDK: create() rejects with gRPC ALREADY_EXISTS (6) if the document is there.
  create: async (data: Doc) => {
    if (mockFailCreateFor.has(String(data['batchId']))) throw new Error('deadline exceeded');
    if (mockStore[collection][id]) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    mockStore[collection][id] = { ...data };
  },
  update: async (data: Doc) => {
    if (mockFailUpdateFor.has(id)) throw new Error('deadline exceeded');
    if (!mockStore[collection][id]) throw new Error(`update of missing doc ${id}`);
    mockStore[collection][id] = { ...mockStore[collection][id], ...data };
  },
});

function mockRunQuery(spec: Spec) {
  mockQueries.push(spec);
  const key = (id: string, doc: Doc) => spec.orders.map((o) => (o.field === '__name__' ? id : doc[o.field])) as string[];
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return 0;
  };
  const docs = Object.entries(mockStore[spec.collection])
    .filter(([, doc]) =>
      spec.filters.every((f) => {
        if (f.op === '==') return doc[f.field] === f.value;
        if (f.op === 'in') return (f.value as unknown[]).includes(doc[f.field]);
        if (f.op === '<') return typeof doc[f.field] === 'string' && (doc[f.field] as string) < (f.value as string);
        throw new Error(`unsupported operator ${f.op}`);
      }),
    )
    .sort(([aId, a], [bId, b]) => compare(key(aId, a), key(bId, b)))
    .filter(([id, doc]) => spec.after === null || compare(key(id, doc), spec.after as string[]) > 0)
    .slice(0, spec.limit ?? Infinity)
    .map(([id, data]) => ({ id, data: () => data, ref: mockDocRef(spec.collection, id) }));
  return { docs, size: docs.length, empty: docs.length === 0 };
}

const mockQuery = (spec: Spec): Record<string, unknown> => ({
  where: (field: string, op: string, value: unknown) => mockQuery({ ...spec, filters: [...spec.filters, { field, op, value }] }),
  orderBy: (field: string, direction = 'asc') => mockQuery({ ...spec, orders: [...spec.orders, { field, direction }] }),
  startAfter: (...values: unknown[]) => mockQuery({ ...spec, after: values }),
  limit: (n: number) => mockQuery({ ...spec, limit: n }),
  get: async () => mockRunQuery(spec),
});

const mockDb = {
  collection: (name: Collection) => {
    if (name !== 'payrollRemittances' && name !== 'incident_log') throw new Error(`unexpected collection ${name}`);
    return {
      ...mockQuery({ collection: name, filters: [], orders: [], after: null, limit: null }),
      doc: (id: string) => mockDocRef(name, id),
    };
  },
};

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
  FieldValue: { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) },
}));

import * as fs from 'fs';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  remittanceOverdueCheck,
  runRemittanceOverdueCheck,
  remittanceAlertDocId,
  MAX_PAGES,
  PAGE_SIZE,
  REMITTANCE_ALERT_SOURCE,
  REMITTANCE_CHECK_TRUNCATED_SOURCE,
} from '../remittanceOverdueCheck';

const db = mockDb as unknown as Firestore;

/** Noon in Mexico City (UTC-6, no DST) on the given date. */
const noon = (isoDate: string) => new Date(`${isoDate}T18:00:00Z`);
const sweep = (isoDate: string, graceDays?: number) => runRemittanceOverdueCheck(db, noon(isoDate), graceDays);

function seedRemittance(batchId: string, over: Doc = {}) {
  mockStore.payrollRemittances[batchId] = {
    batchId,
    employerId: 'employer-1',
    payPeriodStart: '2026-07-01',
    payPeriodEnd: '2026-07-15',
    expectedCents: 170000,
    receivedCents: 0,
    status: 'expected',
    receipts: [],
    ...over,
  };
}

const alerts = () => Object.values(mockStore.incident_log);
/** The queries over the ledger itself (the run also queries open alerts). */
const ledgerQueries = () => mockQueries.filter((q) => q.collection === 'payrollRemittances');
const alertIds = () => Object.keys(mockStore.incident_log).sort();

beforeEach(() => {
  mockStore.payrollRemittances = {};
  mockStore.incident_log = {};
  mockQueries.length = 0;
  mockFailCreateFor.clear();
  mockFailUpdateFor.clear();
  jest.clearAllMocks();
});

describe('runRemittanceOverdueCheck — what it raises', () => {
  // payPeriodEnd 2026-07-15 + 7 days of grace: first overdue day is 2026-07-23.
  it('raises nothing while the record is inside the grace window', async () => {
    seedRemittance('b1');

    const result = await sweep('2026-07-22');

    expect(result).toMatchObject({ asOf: '2026-07-22', graceDays: 7, overdue: 0, raised: [], alreadyRaised: 0, failed: 0 });
    expect(alerts()).toEqual([]);
    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it('raises an incident the ops Alerts page can show on the first overdue day', async () => {
    seedRemittance('b1', { receivedCents: 50000, status: 'partial' });

    const result = await sweep('2026-07-23');

    expect(result.raised).toEqual([
      { batchId: 'b1', employerId: 'employer-1', thresholdDays: 1, daysOverdue: 1, outstandingCents: 120000 },
    ]);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]).toEqual({
      // The fields AlertsPage reads: source, error, severity, ts, resolved.
      source: REMITTANCE_ALERT_SOURCE,
      error: expect.stringContaining('lote b1'),
      severity: 'warning',
      ts: { _serverTimestamp: true },
      resolved: false,
      batchId: 'b1',
      employerId: 'employer-1',
      payPeriodEnd: '2026-07-15',
      expectedCents: 170000,
      receivedCents: 50000,
      outstandingCents: 120000,
      daysOverdue: 1,
      thresholdDays: 1,
      alertEpoch: 0,
      graceDays: 7,
      asOf: '2026-07-23',
    });
    expect(alerts()[0]!['error']).toContain('$1,200.00');
  });

  it('never raises for a settled or overpaid record, however old', async () => {
    seedRemittance('settled', { payPeriodEnd: '2026-01-15', receivedCents: 170000, status: 'received' });
    seedRemittance('overpaid', { payPeriodEnd: '2026-01-15', receivedCents: 200000, status: 'overpaid' });
    // Stored status is stale; the figures say it is paid.
    seedRemittance('stale-status', { payPeriodEnd: '2026-01-15', receivedCents: 170000, status: 'partial' });

    const result = await sweep('2026-07-23');

    expect(result.overdue).toBe(0);
    expect(alerts()).toEqual([]);
  });

  it('asks Firestore only for outstanding records past the grace window, oldest first', async () => {
    seedRemittance('b1');

    await sweep('2026-07-23');

    expect(ledgerQueries()[0]).toMatchObject({
      filters: [
        { field: 'status', op: 'in', value: ['expected', 'partial'] },
        { field: 'payPeriodEnd', op: '<', value: '2026-07-16' },
      ],
      orders: [
        { field: 'payPeriodEnd', direction: 'asc' },
        { field: '__name__', direction: 'asc' },
      ],
    });
  });

  it('takes "today" from Mexico City, not UTC', async () => {
    seedRemittance('b1');

    // 2026-07-23 03:00 UTC is still 21:00 on the 22nd in Mexico City: not overdue yet.
    expect((await runRemittanceOverdueCheck(db, new Date('2026-07-23T03:00:00Z'))).raised).toEqual([]);
    // 06:30 UTC is 00:30 on the 23rd there.
    expect((await runRemittanceOverdueCheck(db, new Date('2026-07-23T06:30:00Z'))).raised).toHaveLength(1);
  });

  it('honours a different grace period', async () => {
    seedRemittance('b1');

    expect((await sweep('2026-07-16', 0)).raised).toMatchObject([{ thresholdDays: 1, daysOverdue: 1 }]);
  });
});

describe('runRemittanceOverdueCheck — one alert per record per threshold', () => {
  it('does not raise again on a second run the same day, nor on the days between thresholds', async () => {
    seedRemittance('b1');

    await sweep('2026-07-23');
    const again = await sweep('2026-07-23');
    expect(again).toMatchObject({ overdue: 1, raised: [], alreadyRaised: 1 });

    for (const day of ['2026-07-24', '2026-07-30', '2026-08-06']) {
      expect((await sweep(day)).raised).toEqual([]);
    }
    expect(alertIds()).toEqual([remittanceAlertDocId('b1', 1)]);
    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
  });

  it('escalates once at 16 and once at 31 days overdue, the last as critical', async () => {
    seedRemittance('b1');

    // Every day from the first overdue day (1 day overdue) to 40 days overdue.
    const start = Date.parse('2026-07-23T18:00:00Z');
    for (let i = 0; i < 40; i++) {
      await runRemittanceOverdueCheck(db, new Date(start + i * 86_400_000));
    }

    expect(alertIds()).toEqual(
      [remittanceAlertDocId('b1', 1), remittanceAlertDocId('b1', 16), remittanceAlertDocId('b1', 31)].sort(),
    );
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 16)]).toMatchObject({ daysOverdue: 16, severity: 'warning', asOf: '2026-08-07' });
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 31)]).toMatchObject({ daysOverdue: 31, severity: 'critical', asOf: '2026-08-22' });
    expect(mockSendSlackAlert).toHaveBeenCalledTimes(3);
    expect(mockSendSlackAlert.mock.calls.map((c) => c[1])).toEqual(['warning', 'warning', 'critical']);
  });

  it('raises one alert, for the highest threshold, when a record is first seen long overdue', async () => {
    seedRemittance('b1', { payPeriodEnd: '2026-05-15' });

    const result = await sweep('2026-07-23');

    expect(result.raised).toMatchObject([{ batchId: 'b1', thresholdDays: 31, daysOverdue: 62 }]);
    expect(alertIds()).toEqual([remittanceAlertDocId('b1', 31)]);
  });

  it('leaves an alert ops dismissed alone', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    mockStore.incident_log[remittanceAlertDocId('b1', 1)]!['resolved'] = true;

    const result = await sweep('2026-07-24');

    expect(result.raised).toEqual([]);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]).toMatchObject({ resolved: true, asOf: '2026-07-23' });
    expect(alerts()).toHaveLength(1);
  });

  it('stops alerting once the money arrives', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 170000, status: 'received' });

    for (const day of ['2026-08-07', '2026-08-22']) {
      expect((await sweep(day)).raised).toEqual([]);
    }
    expect(alerts()).toHaveLength(1);
  });

  it('gives each record its own alert and sends one Slack summary for the run', async () => {
    seedRemittance('b1');
    seedRemittance('b2', { payPeriodEnd: '2026-05-15', expectedCents: 30000 });
    seedRemittance('b3', { payPeriodEnd: '2026-07-20' }); // still in grace

    const result = await sweep('2026-07-23');

    expect(result.raised.map((a) => a.batchId)).toEqual(['b2', 'b1']);
    expect(alertIds()).toEqual([remittanceAlertDocId('b1', 1), remittanceAlertDocId('b2', 31)].sort());
    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
    const [message, severity] = mockSendSlackAlert.mock.calls[0]!;
    expect(message).toContain('2 payroll remittance(s)');
    expect(message).toContain('$2,000.00');
    expect(severity).toBe('critical');
  });
});

describe('runRemittanceOverdueCheck — closing alerts the money has answered', () => {
  it('resolves the open alert once the record is paid, as the system, for the Alerts page', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 170000, status: 'received' });

    const result = await sweep('2026-07-24');

    expect(result).toMatchObject({ resolved: 1, raised: [], failed: 0 });
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]).toMatchObject({
      resolved: true,
      resolvedBy: 'system',
      resolution: 'no-longer-overdue',
      resolvedAt: { _serverTimestamp: true },
      // The alert itself is kept as it was raised.
      asOf: '2026-07-23',
    });
    // Nothing left to close: the next run touches nothing.
    expect((await sweep('2026-07-25')).resolved).toBe(0);
  });

  it('resolves every threshold the record raised, and only that record\'s', async () => {
    seedRemittance('b1', { payPeriodEnd: '2026-05-15' });
    seedRemittance('b2', { payPeriodEnd: '2026-05-15' });
    await sweep('2026-06-01'); // 10 days overdue → threshold 1
    await sweep('2026-06-20'); // 29 days overdue → threshold 16
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 200000, status: 'overpaid' });

    const result = await sweep('2026-06-21');

    expect(result.resolved).toBe(2);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]!['resolved']).toBe(true);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 16)]!['resolved']).toBe(true);
    expect(mockStore.incident_log[remittanceAlertDocId('b2', 1)]!['resolved']).toBe(false);
    expect(mockStore.incident_log[remittanceAlertDocId('b2', 16)]!['resolved']).toBe(false);
  });

  it('keeps the alert open while money is still missing after a partial payment', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 100000, status: 'partial' });

    expect((await sweep('2026-07-24')).resolved).toBe(0);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]!['resolved']).toBe(false);
  });

  it('leaves open an alert whose record cannot be found, and other sources\' incidents alone', async () => {
    mockStore.incident_log[remittanceAlertDocId('gone', 1)] = { source: REMITTANCE_ALERT_SOURCE, batchId: 'gone', resolved: false };
    mockStore.incident_log['system-health_x'] = { source: 'system-health', batchId: 'b1', resolved: false };
    seedRemittance('b1', { receivedCents: 170000, status: 'received' });

    expect((await sweep('2026-07-24')).resolved).toBe(0);
    expect(mockStore.incident_log[remittanceAlertDocId('gone', 1)]!['resolved']).toBe(false);
    expect(mockStore.incident_log['system-health_x']!['resolved']).toBe(false);
  });

  it('keeps going when one alert cannot be closed, and reports it', async () => {
    seedRemittance('b1');
    seedRemittance('b2');
    await sweep('2026-07-23');
    for (const id of ['b1', 'b2']) Object.assign(mockStore.payrollRemittances[id]!, { receivedCents: 170000, status: 'received' });
    mockFailUpdateFor.add(remittanceAlertDocId('b1', 1));

    const result = await sweep('2026-07-24');

    expect(result).toMatchObject({ resolved: 1, failed: 1 });
    expect(mockStore.incident_log[remittanceAlertDocId('b2', 1)]!['resolved']).toBe(true);
  });
});

describe('runRemittanceOverdueCheck — a record re-opened after it was settled', () => {
  it('raises a threshold again in the new cycle, even one the settled cycle already raised', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    // Paid, then the receipt is voided: the record owes again and is in cycle 1.
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 170000, status: 'received' });
    await sweep('2026-07-24');
    Object.assign(mockStore.payrollRemittances['b1']!, { receivedCents: 0, status: 'expected', overdueAlertEpoch: 1 });

    const result = await sweep('2026-07-25');

    expect(result.raised).toEqual([expect.objectContaining({ batchId: 'b1', thresholdDays: 1, daysOverdue: 3 })]);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1, 1)]).toMatchObject({
      resolved: false,
      alertEpoch: 1,
      asOf: '2026-07-25',
    });
    // The first cycle's alert stays as it was closed.
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]).toMatchObject({ resolved: true, asOf: '2026-07-23' });
    // And still only once per threshold within the new cycle.
    expect((await sweep('2026-07-26')).raised).toEqual([]);
    expect(mockSendSlackAlert).toHaveBeenCalledTimes(2);
  });

  it('closes an earlier cycle\'s alert that was still open, as superseded', async () => {
    seedRemittance('b1');
    await sweep('2026-07-23');
    // Settled and re-opened between two runs: the cycle-0 alert was never closed.
    Object.assign(mockStore.payrollRemittances['b1']!, { overdueAlertEpoch: 1 });

    const result = await sweep('2026-07-24');

    expect(result.resolved).toBe(1);
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1)]).toMatchObject({ resolved: true, resolution: 'superseded' });
    expect(mockStore.incident_log[remittanceAlertDocId('b1', 1, 1)]).toMatchObject({ resolved: false, alertEpoch: 1 });
  });

  it('gives each cycle its own ids, which cannot collide even though batch ids contain "_"', () => {
    expect(remittanceAlertDocId('b1', 16)).toBe('remittance-overdue_16d_b1');
    expect(remittanceAlertDocId('b1', 16, 2)).toBe('remittance-overdue_e2_16d_b1');
    expect(remittanceAlertDocId('e1_1d_x', 1, 0)).not.toBe(remittanceAlertDocId('x', 1, 1));
    expect(remittanceAlertDocId('1d_x', 1, 1)).not.toBe(remittanceAlertDocId('x', 1, 11));
  });
});

describe('runRemittanceOverdueCheck — volume and failure', () => {
  it('walks every page of the ledger', async () => {
    for (let i = 0; i < 450; i++) seedRemittance(`batch-${String(i).padStart(4, '0')}`);

    const result = await sweep('2026-07-23');

    expect(result.raised).toHaveLength(450);
    expect(result.truncated).toBe(false);
    expect(alerts()).toHaveLength(450);
    expect(ledgerQueries().length).toBe(3);
    expect(ledgerQueries()[1]!.after).toEqual(['2026-07-15', 'batch-0199']);
    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
  });

  it('stops at its page cap and says so loudly: log, an incident, and a critical Slack line', async () => {
    for (let i = 0; i < 450; i++) seedRemittance(`batch-${String(i).padStart(4, '0')}`);

    const result = await runRemittanceOverdueCheck(db, noon('2026-07-23'), undefined, { maxPages: 2 });

    expect(result.truncated).toBe(true);
    expect(result.raised).toHaveLength(2 * PAGE_SIZE);
    expect(ledgerQueries()).toHaveLength(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('page cap'), expect.objectContaining({ maxPages: 2 }));
    const incident = mockStore.incident_log[`${REMITTANCE_CHECK_TRUNCATED_SOURCE}_2026-07-23`];
    expect(incident).toMatchObject({
      source: REMITTANCE_CHECK_TRUNCATED_SOURCE,
      severity: 'critical',
      resolved: false,
      ts: { _serverTimestamp: true },
      error: expect.stringContaining('400 registros'),
    });
    expect(mockSendSlackAlert).toHaveBeenLastCalledWith(expect.stringContaining('NOT checked'), 'critical');

    // A second truncated run the same day does not raise a second incident.
    await runRemittanceOverdueCheck(db, noon('2026-07-23'), undefined, { maxPages: 2 });
    expect(alerts().filter((a) => a['source'] === REMITTANCE_CHECK_TRUNCATED_SOURCE)).toHaveLength(1);
  });

  it('is not truncated when the last page it reads is the last page there is', async () => {
    for (let i = 0; i < 350; i++) seedRemittance(`batch-${String(i).padStart(4, '0')}`);

    const result = await runRemittanceOverdueCheck(db, noon('2026-07-23'), undefined, { maxPages: 2 });

    expect(result).toMatchObject({ truncated: false });
    expect(result.raised).toHaveLength(350);
    expect(alerts().some((a) => a['source'] === REMITTANCE_CHECK_TRUNCATED_SOURCE)).toBe(false);
  });

  it('caps the walk over open alerts too', async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      const id = `batch-${String(i).padStart(4, '0')}`;
      seedRemittance(id);
      mockStore.incident_log[remittanceAlertDocId(id, 1)] = { source: REMITTANCE_ALERT_SOURCE, batchId: id, resolved: false };
    }

    const result = await runRemittanceOverdueCheck(db, noon('2026-07-23'), undefined, { maxPages: 1 });

    expect(result.truncated).toBe(true);
  });

  it('keeps going when one alert cannot be written, reports it, and raises it on the next run', async () => {
    seedRemittance('b1');
    seedRemittance('b2');
    mockFailCreateFor.add('b1');

    const result = await sweep('2026-07-23');

    expect(result).toMatchObject({ failed: 1 });
    expect(result.raised.map((a) => a.batchId)).toEqual(['b2']);

    mockFailCreateFor.clear();
    expect((await sweep('2026-07-23')).raised.map((a) => a.batchId)).toEqual(['b1']);
  });

  it('a Slack failure does not fail the run or lose the incident', async () => {
    seedRemittance('b1');
    mockSendSlackAlert.mockRejectedValueOnce(new Error('slack down'));

    await expect(sweep('2026-07-23')).resolves.toMatchObject({ failed: 0 });
    expect(alerts()).toHaveLength(1);
  });
});

describe('remittanceOverdueCheck — the scheduled handler', () => {
  const handler = remittanceOverdueCheck as unknown as () => Promise<void>;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(noon('2026-07-23').getTime());
  });
  afterEach(() => nowSpy.mockRestore());

  it('runs the sweep against the current date', async () => {
    seedRemittance('b1');

    await handler();
    await handler();

    expect(alertIds()).toEqual([remittanceAlertDocId('b1', 1)]);
  });

  it('fails the run when an alert could not be written', async () => {
    seedRemittance('b1');
    mockFailCreateFor.add('b1');

    await expect(handler()).rejects.toThrow(/1 alert\(s\) could not be written/);
  });

  it('fails the run when it stopped at the page cap', async () => {
    for (let i = 0; i < MAX_PAGES * PAGE_SIZE + 1; i++) seedRemittance(`batch-${String(i).padStart(5, '0')}`);

    await expect(handler()).rejects.toThrow(/page cap/);
    expect(ledgerQueries()).toHaveLength(MAX_PAGES);
  });
});

describe('remittanceOverdueCheck wiring', () => {
  const repoRoot = path.join(__dirname, '../../../..');

  it('index.ts exports it and deploy.yml deploys it', () => {
    const index = fs.readFileSync(path.join(repoRoot, 'functions/src/index.ts'), 'utf8');
    expect(index).toMatch(/export\s*\{\s*remittanceOverdueCheck\s*\}\s*from\s*'\.\/scheduled\/remittanceOverdueCheck'/);

    const deployYml = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
    const list = /FUNCTIONS="\n([\s\S]*?)\n\s*"/.exec(deployYml)?.[1] ?? '';
    expect(list.split(/\s+/)).toContain('remittanceOverdueCheck');
  });

  it('the ops Alerts page still reads the collection and fields the alert is written with', () => {
    const page = fs.readFileSync(path.join(repoRoot, 'public-v2/src/pages/AlertsPage.tsx'), 'utf8');
    expect(page).toContain("collection(db, 'incident_log')");
    for (const field of ['source', 'error', 'severity', 'ts', 'resolved']) {
      expect(page).toMatch(new RegExp(`d\\.data\\(\\)\\.${field}\\b`));
    }
  });

  it('the indexes its query needs are declared', () => {
    const { indexes } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }>;
    };
    const declared = indexes
      .filter((i) => i.collectionGroup === 'payrollRemittances')
      .map((i) => i.fields.map((f) => `${f.fieldPath}:${f.order}`).join(','));
    expect(declared).toEqual(
      expect.arrayContaining([
        'status:ASCENDING,payPeriodEnd:ASCENDING',
        'employerId:ASCENDING,status:ASCENDING,payPeriodEnd:ASCENDING',
        'employerId:ASCENDING,payPeriodEnd:DESCENDING',
      ]),
    );
  });
});
