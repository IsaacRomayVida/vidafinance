/**
 * Integration-style tests for the POST /webhooks/metamap Express route.
 *
 * Mocks firebase-admin (Firestore), ioredis, and the MetaMap API fetch
 * to test the full request→response→shadow-log flow without real infra.
 */

const crypto = require('crypto');
const http = require('http');

const WEBHOOK_SECRET = 'test-webhook-secret-256bit';
const MOCK_VERIFICATION_RESULT = {
  status: 'verified',
  identity: { fullName: 'Juan Pérez' },
  steps: [],
};

// ── Firebase Admin mock ──────────────────────────────────────────────────────

const mockDocs = {};
const mockIncidentLogs = [];

const mockFirestore = {
  collection: jest.fn((name) => {
    if (name === 'metamap_shadow_log') {
      return {
        doc: jest.fn((id) => ({
          set: jest.fn(async (data, opts) => {
            if (opts?.merge) {
              mockDocs[id] = { ...(mockDocs[id] || {}), ...data };
            } else {
              mockDocs[id] = data;
            }
          }),
        })),
      };
    }
    if (name === 'incident_log') {
      return {
        add: jest.fn(async (data) => {
          mockIncidentLogs.push(data);
          return { id: 'incident-mock' };
        }),
      };
    }
    return { doc: jest.fn(() => ({ set: jest.fn(), get: jest.fn() })) };
  }),
};

jest.mock('firebase-admin', () => {
  const admin = {
    initializeApp: jest.fn(),
    credential: { cert: jest.fn(() => ({})) },
    firestore: jest.fn(() => mockFirestore),
  };
  admin.firestore.FieldValue = {
    serverTimestamp: jest.fn(() => 'SERVER_TIMESTAMP'),
    increment: jest.fn((n) => `INCREMENT(${n})`),
  };
  return admin;
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn(),
  }));
});

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('helmet', () => () => (_req, _res, next) => next());

// Mock node-fetch for MetaMap API calls (getVerificationResult)
jest.mock('node-fetch', () =>
  jest.fn().mockImplementation((url) => {
    if (url.includes('/oauth')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ access_token: 'mock-token' }),
      });
    }
    if (url.includes('/verifications/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(MOCK_VERIFICATION_RESULT),
      });
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not found') });
  })
);

// ── Setup env before app import ──────────────────────────────────────────────

beforeAll(() => {
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'test',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALR...\n-----END RSA PRIVATE KEY-----\n',
    client_email: 'test@test.iam.gserviceaccount.com',
  });
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.METAMAP_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.METAMAP_CLIENT_ID = 'test-client-id';
  process.env.METAMAP_CLIENT_SECRET = 'test-client-secret';
  process.env.INTERNAL_SECRET = 'test-internal';
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex');
}

function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), headers: res.headers });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

let app;

beforeEach(() => {
  // Clear mock state
  Object.keys(mockDocs).forEach((k) => delete mockDocs[k]);
  mockIncidentLogs.length = 0;
  jest.clearAllMocks();

  // Clear require cache so the app re-imports fresh
  delete require.cache[require.resolve('../index')];
  app = require('../index');
});

describe('POST /webhooks/metamap', () => {
  it('returns 200 and logs verification_completed to shadow log', async () => {
    const body = {
      eventName: 'verification_completed',
      resource: 'https://api.getmati.com/v2/verifications/ver-123',
      flowId: 'flow-1',
      timestamp: '2026-03-21T12:00:00.000Z',
      metadata: { loanId: 'loan-1', correlationId: 'corr-1', stage: '4' },
    };
    const sig = sign(body);

    const res = await request(app, 'POST', '/webhooks/metamap', body, { 'x-signature': sig });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(mockDocs['ver-123']).toBeDefined();
    expect(mockDocs['ver-123'].verificationId).toBe('ver-123');
    expect(mockDocs['ver-123'].loanId).toBe('loan-1');
    expect(mockDocs['ver-123'].eventName).toBe('verification_completed');
    expect(mockDocs['ver-123'].status).toBe('verified');
    expect(mockDocs['ver-123'].results).toEqual(MOCK_VERIFICATION_RESULT);
  });

  it('returns 200 and merges step_completed into shadow log', async () => {
    const body = {
      eventName: 'step_completed',
      resource: 'https://api.getmati.com/v2/verifications/ver-456',
      flowId: 'flow-1',
      timestamp: '2026-03-21T12:00:00.000Z',
      step: {
        status: 200,
        id: 'document-reading',
        data: { fullName: 'María López' },
        error: null,
      },
      metadata: { loanId: 'loan-2', correlationId: 'corr-2' },
    };
    const sig = sign(body);

    const res = await request(app, 'POST', '/webhooks/metamap', body, { 'x-signature': sig });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockDocs['ver-456']).toBeDefined();
    expect(mockDocs['ver-456']['steps.document-reading']).toEqual({
      status: 200,
      data: { fullName: 'María López' },
      error: null,
    });
  });

  it('returns 401 on invalid signature and logs to incident_log', async () => {
    const body = {
      eventName: 'verification_completed',
      resource: 'https://api.getmati.com/v2/verifications/ver-789',
      flowId: 'flow-1',
      timestamp: '2026-03-21T12:00:00.000Z',
    };

    const res = await request(app, 'POST', '/webhooks/metamap', body, { 'x-signature': 'bad-sig' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
    expect(mockIncidentLogs.length).toBeGreaterThanOrEqual(1);
    expect(mockIncidentLogs[0].source).toBe('metamap-webhook');
    expect(mockIncidentLogs[0].error).toBe('invalid_signature');
  });

  it('returns 401 when x-signature header is missing', async () => {
    const body = {
      eventName: 'verification_completed',
      resource: 'https://api.getmati.com/v2/verifications/ver-000',
    };

    const res = await request(app, 'POST', '/webhooks/metamap', body, {});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });
});

describe('GET /health', () => {
  it('returns service health status', async () => {
    const res = await request(app, 'GET', '/health', null);

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('vida-underwriting-service');
    expect(res.body.status).toBe('ok');
  });
});
