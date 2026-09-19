/**
 * `systemHealthCheck` polls five downstream services' `/health` endpoints
 * every 5 minutes via `Promise.allSettled` — the whole point of
 * `allSettled` over `Promise.all` is that one dependency being down must not
 * blank out the readings for the other four, and must instead produce a
 * `status: 'down'` entry plus a critical incident for the one that failed.
 * It had zero coverage, so neither the isolation nor the incident-logging
 * side effect was pinned to anything.
 *
 * Mocks are local to this file, matching `queueHealthCheck.test.ts` /
 * `dailyLoanCheck.test.ts`.
 */
export {};

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));

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
import { systemHealthCheck } from '../systemHealthCheck';

const mockFetch = fetch as unknown as jest.Mock;

const SERVICE_URLS: Record<string, string> = {
  'payment-server': 'https://payment.example.test',
  'softcredito-adapter': 'https://softcredito.example.test',
  'notification-service': 'https://notify.example.test',
  'pdf-generator': 'https://pdf.example.test',
  'ml-service': 'https://ml.example.test',
};

async function run(): Promise<void> {
  return (systemHealthCheck as unknown as () => Promise<void>)();
}

type WrittenReading = { status: string; redis?: string; latencyMs?: number; error?: string };

beforeEach(() => {
  jest.clearAllMocks();
  process.env['PAYMENT_SERVER_URL'] = SERVICE_URLS['payment-server'];
  process.env['SOFTCREDITO_ADAPTER_URL'] = SERVICE_URLS['softcredito-adapter'];
  process.env['NOTIFICATION_SERVICE_URL'] = SERVICE_URLS['notification-service'];
  process.env['PDF_GENERATOR_URL'] = SERVICE_URLS['pdf-generator'];
  process.env['ML_SERVICE_URL'] = SERVICE_URLS['ml-service'];
});

afterEach(() => {
  for (const key of [
    'PAYMENT_SERVER_URL',
    'SOFTCREDITO_ADAPTER_URL',
    'NOTIFICATION_SERVICE_URL',
    'PDF_GENERATOR_URL',
    'ML_SERVICE_URL',
  ]) {
    delete process.env[key];
  }
});

describe('systemHealthCheck', () => {
  it('records status, redis and latency for every service when all are healthy, and raises no incident', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', redis: 'connected' }),
    }));

    await run();

    expect(mockFetch).toHaveBeenCalledTimes(5);
    const written = mockSet.mock.calls[0]?.[0] as Record<string, WrittenReading>;
    for (const name of Object.keys(SERVICE_URLS)) {
      expect(written[name]).toMatchObject({ status: 'ok', redis: 'connected' });
      expect(typeof written[name]?.latencyMs).toBe('number');
    }
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('marks a single failed dependency down and logs a critical incident, without losing the other four readings', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === `${SERVICE_URLS['ml-service']}/health`) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ status: 'ok', redis: 'connected' }) };
    });

    await run();

    const written = mockSet.mock.calls[0]?.[0] as Record<string, WrittenReading>;
    expect(written['ml-service']).toMatchObject({ status: 'down', error: 'ECONNREFUSED' });
    // Promise.allSettled, not Promise.all: one dependency throwing must not
    // prevent the other four healthy readings from being written.
    expect(written['payment-server']).toMatchObject({ status: 'ok' });
    expect(written['softcredito-adapter']).toMatchObject({ status: 'ok' });
    expect(written['notification-service']).toMatchObject({ status: 'ok' });
    expect(written['pdf-generator']).toMatchObject({ status: 'ok' });

    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'health-check',
        service: 'ml-service',
        error: 'ECONNREFUSED',
        severity: 'critical',
        resolved: false,
      })
    );
  });

  it('logs a separate critical incident for each of several failed dependencies', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (
        url === `${SERVICE_URLS['ml-service']}/health` ||
        url === `${SERVICE_URLS['pdf-generator']}/health`
      ) {
        throw new Error('timeout');
      }
      return { ok: true, json: async () => ({ status: 'ok', redis: 'connected' }) };
    });

    await run();

    expect(mockAdd).toHaveBeenCalledTimes(2);
    const services = mockAdd.mock.calls.map((c) => (c[0] as { service: string }).service).sort();
    expect(services).toEqual(['ml-service', 'pdf-generator']);
  });

  it('still writes a full report — all five services down — when every dependency fails', async () => {
    mockFetch.mockRejectedValue(new Error('network unreachable'));

    await run();

    const written = mockSet.mock.calls[0]?.[0] as Record<string, WrittenReading>;
    for (const name of Object.keys(SERVICE_URLS)) {
      expect(written[name]).toMatchObject({ status: 'down', error: 'network unreachable' });
    }
    expect(mockAdd).toHaveBeenCalledTimes(5);
  });
});
