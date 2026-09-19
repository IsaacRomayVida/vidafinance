/**
 * `queueHealthCheck` polls the payment server's queue stats every 2 minutes
 * and raises an incident when a queue's failed-job count crosses 50. It had
 * zero coverage, so neither the threshold nor its failure handling (a down
 * payment server, a non-ok response) was pinned to anything.
 *
 * Mocks are local to this file, matching the convention in
 * `satBlacklistRefresh.test.ts` / `dailyLoanCheck.test.ts` — `onSchedule` is
 * stubbed to hand back the raw handler, and Firestore is a tiny hand-rolled
 * fake scoped to the two collections this function touches.
 */
export {};

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
jest.mock('firebase-functions', () => ({ logger: mockLogger }));

const mockSet = jest.fn(async (_data: Record<string, unknown>) => {});
const mockAdd = jest.fn(async (_data: Record<string, unknown>) => ({ id: 'incident-1' }));
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn((name: string) => {
  if (name === 'system_health') return { doc: mockDoc };
  if (name === 'incident_log') return { add: mockAdd };
  throw new Error(`unexpected collection ${name}`);
});
const mockGetFirestore = jest.fn(() => ({ collection: mockCollection }));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockGetFirestore(),
  FieldValue: { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) },
}));

import fetch from 'node-fetch';
import { queueHealthCheck } from '../queueHealthCheck';

const mockFetch = fetch as unknown as jest.Mock;

async function run(): Promise<void> {
  return (queueHealthCheck as unknown as () => Promise<void>)();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env['PAYMENT_SERVER_URL'] = 'https://payments.example.test';
  process.env['INTERNAL_SECRET'] = 'shh';
});

afterEach(() => {
  delete process.env['PAYMENT_SERVER_URL'];
  delete process.env['INTERNAL_SECRET'];
});

describe('queueHealthCheck', () => {
  it('records queue stats with the internal secret header, and raises no incident when every queue is healthy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ queues: { default: { failed: 3 }, notifications: { failed: 0 } } }),
    });

    await run();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://payments.example.test/internal/queue-stats',
      expect.objectContaining({ headers: { 'x-internal-secret': 'shh' } })
    );
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ default: { failed: 3 }, notifications: { failed: 0 } })
    );
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('logs a warning-severity incident once a queue crosses the 50-failed threshold', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ queues: { default: { failed: 51 } } }),
    });

    await run();

    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'queue-monitor',
        queue: 'default',
        failedCount: 51,
        severity: 'warning',
        resolved: false,
      })
    );
  });

  it('does not flag a queue sitting exactly at 50 failed jobs — the gate is strictly greater-than', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ queues: { default: { failed: 50 } } }),
    });

    await run();

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('raises one incident per queue that crosses the threshold, not just the first', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        queues: { default: { failed: 51 }, notifications: { failed: 200 }, low: { failed: 1 } },
      }),
    });

    await run();

    expect(mockAdd).toHaveBeenCalledTimes(2);
    const flagged = mockAdd.mock.calls.map((c) => (c[0] as { queue: string }).queue).sort();
    expect(flagged).toEqual(['default', 'notifications']);
  });

  it('writes nothing when the payment server responds with a non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    await run();

    expect(mockSet).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('does not throw when the payment server is unreachable — it logs and returns instead of crashing the scheduled run', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(run()).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue health check failed',
      expect.objectContaining({ error: 'ECONNREFUSED', service: 'functions' })
    );
    expect(mockSet).not.toHaveBeenCalled();
  });
});
