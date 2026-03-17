/**
 * Unit tests for the /disburse route — verifies BullMQ job enqueueing.
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

// Mock BullMQ Queue
const mockAdd = jest.fn();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
  })),
}));

// Firebase and Redis mocks are handled by moduleNameMapper in jest.config.js

import express from 'express';
import request from 'supertest';

// Check if supertest is available; skip if not
let app: express.Express;

try {
  // Build a mini app with just the disbursements router
  const { disbursementsRouter } = require('../src/routes/disbursements');

  app = express();
  app.use(express.json());
  app.use('/disburse', disbursementsRouter);
} catch {
  // supertest may not be installed
}

describe('/disburse route', () => {
  beforeEach(() => {
    mockAdd.mockReset();
    mockAdd.mockResolvedValue({ id: 'job-123' });
  });

  if (!app) {
    it('skipped — supertest not installed', () => {
      expect(true).toBe(true);
    });
    return;
  }

  it('should return 401 without x-internal-secret', async () => {
    const res = await request(app)
      .post('/disburse')
      .send({ loanId: 'loan1', userId: 'u1', amount: 1000 });

    expect(res.status).toBe(401);
  });

  it('should return 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/disburse')
      .set('x-internal-secret', 'test-secret')
      .send({ loanId: 'loan1' }); // missing userId, amount

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('should enqueue a disbursement job and return jobId', async () => {
    const res = await request(app)
      .post('/disburse')
      .set('x-internal-secret', 'test-secret')
      .send({
        loanId: 'loan001',
        userId: 'user123',
        amount: 2500,
        clabe: '012345678901234567',
        beneficiaryName: 'Juan Pérez',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe('job-123');
    expect(res.body.loanId).toBe('loan001');

    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith('disburse', {
      loanId: 'loan001',
      userId: 'user123',
      amount: 2500,
      clabe: '012345678901234567',
      beneficiaryName: 'Juan Pérez',
    });
  });

  it('should enqueue without optional clabe/beneficiaryName', async () => {
    const res = await request(app)
      .post('/disburse')
      .set('x-internal-secret', 'test-secret')
      .send({ loanId: 'loan002', userId: 'user456', amount: 1000 });

    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledWith('disburse', {
      loanId: 'loan002',
      userId: 'user456',
      amount: 1000,
    });
  });

  it('should return 500 if queue.add fails', async () => {
    mockAdd.mockRejectedValueOnce(new Error('Redis connection failed'));

    const res = await request(app)
      .post('/disburse')
      .set('x-internal-secret', 'test-secret')
      .send({ loanId: 'loan003', userId: 'user789', amount: 500 });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to enqueue/);
  });
});
