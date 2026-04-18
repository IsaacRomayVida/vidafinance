import { createHmac } from 'crypto';
import { metamapWebhook } from '../metamap';
import { getFirestore } from '../../__mocks__/firebase-admin/firestore';

type Handler = (req: unknown, res: unknown) => Promise<void>;
const fn = metamapWebhook as unknown as Handler;

const SECRET = 'test-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  json: jest.Mock;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(opts: {
  method?: string;
  body?: Record<string, unknown>;
  rawBody?: Buffer;
  signature?: string | null;
  headers?: Record<string, string | undefined>;
}) {
  const body = opts.body ?? {};
  const rawBody = opts.rawBody ?? Buffer.from(JSON.stringify(body), 'utf8');
  const headers: Record<string, string | undefined> = { ...(opts.headers ?? {}) };
  if (opts.signature !== null && opts.signature !== undefined) {
    headers['x-metamap-signature'] = opts.signature;
  }
  return {
    method: opts.method ?? 'POST',
    headers,
    rawBody,
    body,
    ip: '127.0.0.1',
  };
}

// Track state across tests: per-collection updates.
interface TrackedDocRef {
  id: string;
  collection: string;
  update: jest.Mock;
}
interface TestStore {
  loanUpdates: Record<string, Record<string, unknown>[]>;
  webhookEvents: Record<string, unknown>[];
  employeeQueryResult:
    | { empty: true }
    | { empty: false; id: string; data: Record<string, unknown>; updateMock: jest.Mock };
}

let store: TestStore;

function installDb() {
  store = {
    loanUpdates: {},
    webhookEvents: [],
    employeeQueryResult: { empty: true },
  };

  const db = {
    collection: jest.fn((name: string) => {
      if (name === 'webhookEvents') {
        return {
          add: jest.fn(async (data: unknown) => {
            store.webhookEvents.push(data as Record<string, unknown>);
            return { id: 'wh-1' };
          }),
        };
      }
      if (name === 'loans') {
        return {
          doc: jest.fn((id: string): TrackedDocRef => {
            const update = jest.fn(async (data: Record<string, unknown>) => {
              (store.loanUpdates[id] ??= []).push(data);
            });
            return { id, collection: 'loans', update };
          }),
        };
      }
      return {
        doc: jest.fn(() => ({ update: jest.fn(async () => {}), set: jest.fn(async () => {}) })),
        add: jest.fn(async () => ({ id: 'x' })),
      };
    }),
    collectionGroup: jest.fn((_name: string) => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => ({
          get: jest.fn(async () => {
            const q = store.employeeQueryResult;
            if (q.empty) return { empty: true, docs: [] };
            const docRef = {
              update: q.updateMock,
            };
            return {
              empty: false,
              docs: [
                {
                  id: q.id,
                  ref: docRef,
                  data: () => q.data,
                },
              ],
            };
          }),
        })),
      })),
    })),
  };

  (getFirestore as jest.Mock).mockReturnValue(db);
}

describe('metamapWebhook', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, METAMAP_WEBHOOK_SECRET: SECRET };
    installDb();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('method + signature validation', () => {
    it('rejects non-POST with 405', async () => {
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ error: 'method_not_allowed' });
    });

    it('returns 500 when METAMAP_WEBHOOK_SECRET is missing', async () => {
      delete process.env.METAMAP_WEBHOOK_SECRET;
      const req = makeReq({ body: { eventName: 'verification.completed' } });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'webhook_not_configured' });
    });

    it('rejects missing signature with 401', async () => {
      const req = makeReq({ body: { eventName: 'verification.completed' }, signature: null });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_signature' });
    });

    it('rejects invalid signature with 401', async () => {
      const req = makeReq({
        body: { eventName: 'verification.completed' },
        signature: 'deadbeef'.repeat(8),
      });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_signature' });
    });

    it('rejects non-hex signature with 401', async () => {
      const req = makeReq({
        body: { eventName: 'verification.completed' },
        signature: 'not-a-hex-string!!',
      });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('verification.completed', () => {
    it('updates employee doc with metamapStatus on valid signature', async () => {
      const updateMock = jest.fn(async () => {});
      store = {
        loanUpdates: {},
        webhookEvents: [],
        employeeQueryResult: {
          empty: false,
          id: 'emp-1',
          data: { metamapVerifiedAt: null },
          updateMock,
        },
      };
      (getFirestore as jest.Mock).mockReturnValue({
        collection: jest.fn((name: string) => {
          if (name === 'webhookEvents') {
            return {
              add: jest.fn(async (data: unknown) => {
                store.webhookEvents.push(data as Record<string, unknown>);
                return { id: 'wh-1' };
              }),
            };
          }
          return { doc: jest.fn(() => ({ update: jest.fn(async () => {}) })) };
        }),
        collectionGroup: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => ({
              get: jest.fn(async () => ({
                empty: false,
                docs: [
                  {
                    id: 'emp-1',
                    ref: { update: updateMock },
                    data: () => ({ metamapVerifiedAt: null }),
                  },
                ],
              })),
            })),
          })),
        })),
      });

      const body = {
        eventName: 'verification.completed',
        identity: { id: 'verif-123' },
        status: 'verified',
      };
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const req = makeReq({ body, rawBody: raw, signature: sign(raw.toString('utf8')) });
      const res = makeRes();
      await fn(req, res);

      expect(res.statusCode).toBe(200);
      expect(updateMock).toHaveBeenCalledTimes(1);
      const calls = updateMock.mock.calls as unknown as Array<[Record<string, unknown>]>;
      const updateArg = calls[0]?.[0];
      expect(updateArg).toBeDefined();
      expect(updateArg?.['metamapStatus']).toBe('verified');
      expect(updateArg?.['metamapVerifiedAt']).toBeDefined();
      expect(updateArg?.['metamapLastEventAt']).toBeDefined();
      expect(store.webhookEvents).toHaveLength(1);
      expect(store.webhookEvents[0]).toMatchObject({
        source: 'metamap',
        eventName: 'verification.completed',
      });
    });

    it('logs and returns 200 when no matching employee', async () => {
      const body = {
        eventName: 'verification.completed',
        identity: { id: 'unknown-verif' },
        status: 'verified',
      };
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const req = makeReq({ body, rawBody: raw, signature: sign(raw.toString('utf8')) });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(200);
      expect(store.webhookEvents).toHaveLength(1);
    });
  });

  describe('document.signed', () => {
    it('updates loan doc with contractSignedAt on valid signature', async () => {
      const body = {
        eventName: 'document.signed',
        loanId: 'loan-xyz',
        documentId: 'doc-789',
        signedAt: '2026-04-18T12:00:00Z',
      };
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const req = makeReq({ body, rawBody: raw, signature: sign(raw.toString('utf8')) });
      const res = makeRes();
      await fn(req, res);

      expect(res.statusCode).toBe(200);
      expect(store.loanUpdates['loan-xyz']).toBeDefined();
      const update = store.loanUpdates['loan-xyz']?.[0] as Record<string, unknown>;
      expect(update).toBeDefined();
      expect(update['contractStatus']).toBe('signed');
      expect(update['contractSignedAt']).toBeDefined();
      expect(update['contractMetamapDocumentId']).toBe('doc-789');
      expect(store.webhookEvents[0]).toMatchObject({
        source: 'metamap',
        eventName: 'document.signed',
      });
    });

    it('skips update when loanId is missing', async () => {
      const body = { eventName: 'document.signed', documentId: 'doc-789' };
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const req = makeReq({ body, rawBody: raw, signature: sign(raw.toString('utf8')) });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(200);
      expect(store.loanUpdates).toEqual({});
      expect(store.webhookEvents).toHaveLength(1);
    });
  });

  describe('unknown events', () => {
    it('audit-logs but does not error on unrecognized eventName', async () => {
      const body = { eventName: 'something.else', foo: 'bar' };
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const req = makeReq({ body, rawBody: raw, signature: sign(raw.toString('utf8')) });
      const res = makeRes();
      await fn(req, res);
      expect(res.statusCode).toBe(200);
      expect(store.webhookEvents).toHaveLength(1);
      expect(store.webhookEvents[0]).toMatchObject({ eventName: 'something.else' });
    });
  });
});
