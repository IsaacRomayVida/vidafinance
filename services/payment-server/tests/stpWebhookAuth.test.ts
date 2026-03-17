/**
 * Unit tests for STP webhook bearer token verification.
 */

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
process.env.STP_WEBHOOK_TOKEN = 'stp-bearer-test-token';

// Firebase and Redis mocks are handled by moduleNameMapper in jest.config.js

import express from 'express';
import request from 'supertest';
import { db, __resetMockStore } from './__mocks__/firebase';

const { webhooksRouter } = require('../src/routes/webhooks');

const app = express();
// Use raw body like production setup
app.use(express.raw({ type: 'application/json', limit: '10kb' }));
app.use('/webhooks', webhooksRouter);

describe('STP webhook bearer token verification', () => {
  beforeEach(() => {
    __resetMockStore();
    jest.clearAllMocks();
  });

  it('should reject requests with missing bearer token when STP_WEBHOOK_TOKEN is set', async () => {
    const res = await request(app)
      .post('/webhooks/stp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ folioOrigen: 'VIDA-test-123', estado: 'LQ' }));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should reject requests with wrong bearer token', async () => {
    const res = await request(app)
      .post('/webhooks/stp')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer wrong-token')
      .send(JSON.stringify({ folioOrigen: 'VIDA-test-123', estado: 'LQ' }));

    expect(res.status).toBe(401);
  });

  it('should accept requests with correct bearer token', async () => {
    // With correct token, code skips incident_log and goes straight to disbursements query
    const mockWhere = jest.fn().mockReturnThis();
    const mockLimit = jest.fn().mockReturnThis();
    const mockGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });

    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: mockWhere,
      limit: mockLimit,
      get: mockGet,
    }));

    const res = await request(app)
      .post('/webhooks/stp')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer stp-bearer-test-token')
      .send(JSON.stringify({ folioOrigen: 'VIDA-test-123', estado: 'LQ' }));

    // Should pass auth and proceed (200 with warning since no disbursement found)
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should allow requests when STP_WEBHOOK_TOKEN is not set', async () => {
    const orig = process.env.STP_WEBHOOK_TOKEN;
    delete process.env.STP_WEBHOOK_TOKEN;

    (db.collection as jest.Mock).mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValueOnce({ empty: true, docs: [] }),
    }));

    const res = await request(app)
      .post('/webhooks/stp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ folioOrigen: 'VIDA-test-456', estado: 'LQ' }));

    expect(res.status).toBe(200);

    process.env.STP_WEBHOOK_TOKEN = orig;
  });
});
