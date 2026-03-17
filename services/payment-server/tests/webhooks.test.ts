/**
 * Unit tests for STP webhook estado parsing logic.
 * Uses the firebase and redis mocks defined in tests/__mocks__.
 */

// Set required env vars before any imports
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'test',
  private_key_id: 'key',
  private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test.iam.gserviceaccount.com',
  client_id: '123',
  auth_uri: '',
  token_uri: '',
});
process.env.INTERNAL_API_SECRET = 'test-secret';

import { db, __setMockData, __resetMockStore } from './__mocks__/firebase';
import { redis, __getPushed, __resetPushed } from './__mocks__/redis';

// ── Parse estado helpers (extracted from webhooks.ts logic for unit testing) ──

type StpEstado = 'LQ' | 'DE' | string;

interface DisbursementDoc {
  stpFolioOrigen: string;
  status: string;
  amount: number;
  userId: string;
}

interface WebhookProcessResult {
  action: 'confirmed' | 'returned' | 'unhandled' | 'not_found';
  loanId?: string;
  notificationPushed?: boolean;
}

/**
 * Pure function extracted from the webhook handler for unit testing.
 * Mirrors the real handler logic without HTTP layer.
 */
async function processStpWebhook(
  folioOrigen: string,
  estado: StpEstado,
  id: string | number,
  claveRastreo: string,
): Promise<WebhookProcessResult> {
  const disbQuery = await (db.collection('disbursements') as ReturnType<typeof db.collection>)
    .where('stpFolioOrigen', '==', folioOrigen)
    .limit(1)
    .get();

  if (disbQuery.empty) {
    return { action: 'not_found' };
  }

  const disbDoc = disbQuery.docs[0];
  const loanId = disbDoc.id;
  const disbData = disbDoc.data() as DisbursementDoc;

  if (estado === 'LQ') {
    await disbDoc.ref.update({
      status: 'confirmed',
      stpTransactionId: String(id),
      stpClaveRastreo: claveRastreo,
    });
    return { action: 'confirmed', loanId };
  }

  if (estado === 'DE') {
    await disbDoc.ref.update({ status: 'returned' });
    const pushCount = await redis.lpush(
      'jobs:notifications',
      JSON.stringify({ type: 'loan_disbursement_failed', userId: disbData.userId, loanId }),
    );
    return { action: 'returned', loanId, notificationPushed: pushCount > 0 };
  }

  return { action: 'unhandled', loanId };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('STP webhook estado parsing', () => {
  beforeEach(() => {
    __resetMockStore();
    __resetPushed();
    jest.clearAllMocks();

    // Seed a disbursement document
    __setMockData('disbursements/loan001', {
      stpFolioOrigen: 'VIDA-loan001-1700000000000',
      status: 'pending_confirmation',
      amount: 2000,
      userId: 'user123',
    });
  });

  it('should handle LQ (liquidada) estado', async () => {
    // Make where().limit().get() return our seeded doc
    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'loan001',
            data: () => ({
              stpFolioOrigen: 'VIDA-loan001-1700000000000',
              status: 'pending_confirmation',
              amount: 2000,
              userId: 'user123',
            }),
            ref: {
              update: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }),
    }));

    const result = await processStpWebhook(
      'VIDA-loan001-1700000000000',
      'LQ',
      42,
      'RASTREO-001',
    );

    expect(result.action).toBe('confirmed');
    expect(result.loanId).toBe('loan001');
  });

  it('should handle DE (devuelta) estado and push notification', async () => {
    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'loan002',
            data: () => ({
              stpFolioOrigen: 'VIDA-loan002-1700000000000',
              status: 'pending_confirmation',
              amount: 3000,
              userId: 'user456',
            }),
            ref: {
              update: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }),
    }));

    const result = await processStpWebhook(
      'VIDA-loan002-1700000000000',
      'DE',
      99,
      '',
    );

    expect(result.action).toBe('returned');
    expect(result.loanId).toBe('loan002');
    expect(result.notificationPushed).toBe(true);

    const pushed = __getPushed();
    expect(pushed.length).toBeGreaterThan(0);
    const payload = JSON.parse(pushed[0][1]);
    expect(payload.type).toBe('loan_disbursement_failed');
    expect(payload.userId).toBe('user456');
  });

  it('should return not_found for unknown folioOrigen', async () => {
    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValueOnce({ empty: true, docs: [] }),
    }));

    const result = await processStpWebhook(
      'VIDA-unknown-999',
      'LQ',
      1,
      '',
    );

    expect(result.action).toBe('not_found');
  });

  it('should return unhandled for unknown estado', async () => {
    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'loan003',
            data: () => ({ stpFolioOrigen: 'VIDA-loan003', status: 'pending_confirmation', amount: 500, userId: 'u1' }),
            ref: { update: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }),
    }));

    const result = await processStpWebhook('VIDA-loan003', 'UNKNOWN_ESTADO', 5, '');
    expect(result.action).toBe('unhandled');
  });
});
