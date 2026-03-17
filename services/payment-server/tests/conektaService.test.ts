/**
 * Unit tests for Conekta OXXO service.
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
process.env.CONEKTA_API_KEY = 'key_test_abc123';

// Mock the conekta SDK
const mockCreateOrder = jest.fn();
jest.mock('conekta', () => ({
  Configuration: jest.fn(),
  OrdersApi: jest.fn().mockImplementation(() => ({
    createOrder: mockCreateOrder,
  })),
}));

// Firebase and Redis mocks are handled by moduleNameMapper in jest.config.js

import { __resetMockStore, __getMockStore } from './__mocks__/firebase';
import { createOxxoPaymentLink, __resetOrdersApi } from '../src/services/conektaService';

describe('conektaService — createOxxoPaymentLink', () => {
  beforeEach(() => {
    __resetMockStore();
    __resetOrdersApi();
    mockCreateOrder.mockReset();
  });

  it('should create an OXXO order via Conekta SDK and store in Firestore', async () => {
    mockCreateOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_test_123',
        charges: {
          data: [
            {
              id: 'chr_test_456',
              payment_method: {
                reference: '93000000000012',
                expires_at: 1700100000,
              },
            },
          ],
        },
      },
    });

    const result = await createOxxoPaymentLink({
      loanId: 'loan001',
      amount: 1500,
      borrowerName: 'Juan Pérez',
      borrowerEmail: 'juan@example.com',
      borrowerPhone: '+5215512345678',
      expiresAt: 1700100000000,
    });

    expect(result.orderId).toBe('ord_test_123');
    expect(result.paymentReference).toBe('93000000000012');
    expect(result.expiresAt).toBe(1700100000);

    // Verify Conekta SDK was called with correct params
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    const [orderReq, lang] = mockCreateOrder.mock.calls[0];
    expect(orderReq.currency).toBe('MXN');
    expect(orderReq.customer_info.name).toBe('Juan Pérez');
    expect(orderReq.customer_info.phone).toBe('+5215512345678');
    expect(orderReq.line_items[0].unit_price).toBe(150000); // cents
    expect(orderReq.charges[0].payment_method.type).toBe('oxxo_cash');
    expect(orderReq.metadata.loan_id).toBe('loan001');
    expect(lang).toBe('es');

    // Verify Firestore write
    const store = __getMockStore();
    const oxxoDoc = store['oxxo_links/loan001'];
    expect(oxxoDoc).toBeDefined();
    expect(oxxoDoc.conektaOrderId).toBe('ord_test_123');
    expect(oxxoDoc.paymentReference).toBe('93000000000012');
    expect(oxxoDoc.status).toBe('pending');
  });

  it('should throw if CONEKTA_API_KEY is not set', async () => {
    const orig = process.env.CONEKTA_API_KEY;
    delete process.env.CONEKTA_API_KEY;
    __resetOrdersApi();

    await expect(
      createOxxoPaymentLink({
        loanId: 'loan002',
        amount: 500,
        borrowerName: 'Test',
        borrowerEmail: 'test@example.com',
        borrowerPhone: '+5215500000000',
        expiresAt: Date.now() + 86400000,
      }),
    ).rejects.toThrow('CONEKTA_API_KEY not configured');

    process.env.CONEKTA_API_KEY = orig;
  });

  it('should handle Conekta API errors', async () => {
    mockCreateOrder.mockRejectedValueOnce(new Error('Conekta API: 422 Unprocessable Entity'));

    await expect(
      createOxxoPaymentLink({
        loanId: 'loan003',
        amount: 100,
        borrowerName: 'Test',
        borrowerEmail: 'test@example.com',
        borrowerPhone: '+5215500000000',
        expiresAt: Date.now() + 86400000,
      }),
    ).rejects.toThrow('Conekta API: 422 Unprocessable Entity');
  });
});
