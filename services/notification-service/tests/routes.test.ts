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
process.env.INTERNAL_SECRET = 'test-secret';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-token';

// Mock bullmq Queue before importing routes
const mockAdd = jest.fn().mockResolvedValue({ id: 'job-123' });
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    isRunning: () => true,
    on: jest.fn(),
  })),
}));

// Mock twilio
jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: jest.fn() },
})));

// Mock sendgrid
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { notificationsRouter } from '../src/routes/notifications';
import { webhooksRouter } from '../src/routes/webhooks';

describe('Notification routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/notifications', notificationsRouter);
  app.use('/webhooks', webhooksRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdd.mockResolvedValue({ id: 'job-123' });
  });

  describe('POST /notifications/send', () => {
    it('should reject requests without internal secret', async () => {
      const res = await request(app)
        .post('/notifications/send')
        .send({ type: 'loan_approved', amount: 5000 });

      expect(res.status).toBe(401);
    });

    it('should reject requests without type', async () => {
      const res = await request(app)
        .post('/notifications/send')
        .set('x-internal-secret', 'test-secret')
        .send({ amount: 5000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type');
    });

    it('should enqueue a notification job', async () => {
      const res = await request(app)
        .post('/notifications/send')
        .set('x-internal-secret', 'test-secret')
        .send({ type: 'loan_approved', userId: 'u1', amount: 5000 });

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.jobId).toBe('job-123');
      expect(mockAdd).toHaveBeenCalledWith('loan_approved', {
        type: 'loan_approved',
        userId: 'u1',
        amount: 5000,
      });
    });
  });

  describe('POST /webhooks/twilio/status', () => {
    it('should return 400 when MessageSid is missing', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/status')
        .send({ MessageStatus: 'delivered' });

      expect(res.status).toBe(400);
    });

    it('should return 200 for valid Twilio callback', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/status')
        .send({ MessageSid: 'SM123', MessageStatus: 'delivered' });

      expect(res.status).toBe(200);
    });

    it('should handle error codes gracefully', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/status')
        .send({ MessageSid: 'SM456', MessageStatus: 'failed', ErrorCode: '30001' });

      expect(res.status).toBe(200);
    });
  });
});
