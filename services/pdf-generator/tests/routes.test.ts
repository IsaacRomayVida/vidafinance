import express from 'express';
import request from 'supertest';

// Mock pdfService before importing routes
jest.mock('../src/services/pdfService', () => ({
  renderPDF: jest.fn(async () => Buffer.from('fake-pdf-content')),
  uploadPDF: jest.fn(async (_buf: Buffer, path: string) => `https://storage.googleapis.com/test-bucket/${path}`),
  getBrowser: jest.fn(),
  closeBrowser: jest.fn(),
}));

// Mock BullMQ Queue
const mockAdd = jest.fn(async (_name: string, _data: unknown) => ({ id: 'job-123' }));
const mockGetJob = jest.fn();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    getJob: mockGetJob,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    isRunning: jest.fn(() => true),
  })),
}));

import { generateRouter } from '../src/routes/generate';

const INTERNAL_SECRET = 'test-secret-123';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/generate', generateRouter);
  return app;
}

beforeAll(() => {
  process.env.INTERNAL_SECRET = INTERNAL_SECRET;
  process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('POST /generate/async', () => {
  const app = createApp();

  it('returns 401 without internal secret', async () => {
    const res = await request(app).post('/generate/async').send({ type: 'loan_contract' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid type', async () => {
    const res = await request(app)
      .post('/generate/async')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ type: 'invalid_type' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid type');
  });

  it('enqueues a loan_contract job', async () => {
    const res = await request(app)
      .post('/generate/async')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ type: 'loan_contract', loanId: 'loan-abc', employeeId: 'emp-123' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.jobId).toBe('job-123');
    expect(mockAdd).toHaveBeenCalledWith('loan_contract', expect.objectContaining({
      type: 'loan_contract',
      loanId: 'loan-abc',
    }));
  });

  it('enqueues a deduction_report job', async () => {
    const res = await request(app)
      .post('/generate/async')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ type: 'deduction_report', employerId: 'emp-xyz', periodLabel: 'marzo 2026' });
    expect(res.status).toBe(202);
    expect(res.body.type).toBe('deduction_report');
  });

  it('enqueues a portfolio_report job', async () => {
    const res = await request(app)
      .post('/generate/async')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ type: 'portfolio_report', month: '2026-03' });
    expect(res.status).toBe(202);
    expect(res.body.type).toBe('portfolio_report');
  });
});

describe('POST /generate/sync', () => {
  const app = createApp();

  it('returns 401 without internal secret', async () => {
    const res = await request(app).post('/generate/sync').send({ template: 'contract', data: {} });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid template', async () => {
    const res = await request(app)
      .post('/generate/sync')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ template: 'nonexistent', data: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid template');
  });

  it('generates a PDF and returns binary when no storagePath', async () => {
    const res = await request(app)
      .post('/generate/sync')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({
        template: 'contract',
        data: {
          loanId: 'ABC123',
          issuedDate: '17/03/2026',
          dueDate: '16/04/2026',
          employeeName: 'Test User',
          employerName: 'Test Corp',
          amount: '5,000.00',
          fee: '1,500.00',
          total: '6,500.00',
          cat: '1355',
          sofomRfc: 'VIDA240101XXX',
          sofomAddress: 'Reforma 250',
        },
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('generates a PDF and uploads when storagePath is provided', async () => {
    const res = await request(app)
      .post('/generate/sync')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({
        template: 'receipt',
        data: {
          loanId: 'DEF456',
          paymentDate: '17/03/2026',
          employeeName: 'Test User',
          employerName: 'Test Corp',
          amount: '6,500.00',
          reference: 'REF-123',
          paymentMethod: 'Nomina',
          sofomRfc: 'VIDA240101XXX',
          sofomAddress: 'Reforma 250',
        },
        storagePath: 'test/receipt.pdf',
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('test/receipt.pdf');
    expect(res.body.size).toBeGreaterThan(0);
  });
});

describe('GET /generate/templates', () => {
  const app = createApp();

  it('returns available templates', async () => {
    const res = await request(app)
      .get('/generate/templates')
      .set('x-internal-secret', INTERNAL_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.templates).toContain('contract');
    expect(res.body.templates).toContain('deduction-report');
    expect(res.body.templates).toContain('portfolio-report');
    expect(res.body.templates).toContain('receipt');
  });
});

describe('GET /generate/status/:jobId', () => {
  const app = createApp();

  it('returns 404 for unknown job', async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/generate/status/unknown-job')
      .set('x-internal-secret', INTERNAL_SECRET);
    expect(res.status).toBe(404);
  });

  it('returns job status for known job', async () => {
    mockGetJob.mockResolvedValueOnce({
      id: 'job-456',
      data: { type: 'loan_contract' },
      getState: jest.fn(async () => 'completed'),
      progress: 100,
      failedReason: null,
      finishedOn: Date.now(),
    });
    const res = await request(app)
      .get('/generate/status/job-456')
      .set('x-internal-secret', INTERNAL_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('completed');
    expect(res.body.type).toBe('loan_contract');
  });
});
