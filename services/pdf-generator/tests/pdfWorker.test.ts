// Mock pdfService before importing worker
jest.mock('../src/services/pdfService', () => ({
  renderPDF: jest.fn(async () => Buffer.from('mock-pdf')),
  uploadPDF: jest.fn(async (_buf: Buffer, path: string) => `https://storage.googleapis.com/test-bucket/${path}`),
  getBrowser: jest.fn(),
  closeBrowser: jest.fn(),
}));

// Mock BullMQ Worker
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Function) => {
    // Store the processor so we can test it
    (global as any).__pdfProcessor = processor;
    return {
      on: jest.fn(),
      isRunning: jest.fn(() => true),
    };
  }),
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
  })),
}));

import { __setMockData, __resetMockStore, __setQueryDocs } from './__mocks__/firebase';

// We need to import after mocks are set up
// The worker module is imported indirectly via its exports
import '../src/workers/pdfWorker';

const mockProcessor = (global as any).__pdfProcessor;

function makeJob(data: Record<string, unknown>) {
  return {
    id: 'test-job-1',
    data,
  };
}

beforeEach(() => {
  __resetMockStore();
  process.env.SOFOM_RFC = 'VIDA240101XXX';
  process.env.SOFOM_ADDRESS = 'Reforma 250, CDMX';
});

describe('pdfWorker — loan_contract', () => {
  it('processes a loan_contract job', async () => {
    const dueDate = new Date('2026-04-16');
    __setMockData('loans/loan-abc', {
      employeeName: 'Juan Perez',
      employerName: 'ACME Corp',
      amount: 5000,
      fee: 1500,
      total: 6500,
      dueDate: { toDate: () => dueDate },
    });

    const job = makeJob({
      type: 'loan_contract',
      loanId: 'loan-abc',
      employeeId: 'emp-123',
    });

    await expect(mockProcessor(job)).resolves.toBeUndefined();
  });

  it('throws when loanId is missing', async () => {
    const job = makeJob({ type: 'loan_contract' });
    await expect(mockProcessor(job)).rejects.toThrow('loanId required');
  });

  it('throws when loan is not found', async () => {
    const job = makeJob({ type: 'loan_contract', loanId: 'nonexistent' });
    await expect(mockProcessor(job)).rejects.toThrow('not found');
  });
});

describe('pdfWorker — repayment_receipt', () => {
  it('processes a repayment_receipt job', async () => {
    __setMockData('loans/loan-def', {
      employeeName: 'Maria Lopez',
      employerName: 'Tech SA',
      total: 6500,
      repaymentRef: 'REF-789',
    });

    const job = makeJob({
      type: 'repayment_receipt',
      loanId: 'loan-def',
      amount: 6500,
      chargeId: 'CHG-001',
    });

    await expect(mockProcessor(job)).resolves.toBeUndefined();
  });
});

describe('pdfWorker — deduction_report', () => {
  it('processes a deduction_report job', async () => {
    __setMockData('employers/employer-xyz', {
      companyName: 'ACME Corp',
      rfc: 'ACM010101XXX',
      clabe: '012345678901234567',
    });

    __setQueryDocs([
      {
        id: 'loan-1',
        data: () => ({
          employeeName: 'Juan Perez',
          employeeNumber: 'EMP-001',
          amount: 5000,
          fee: 1500,
          total: 6500,
          remainingBalance: 6500,
          dueDate: { toDate: () => new Date('2026-04-16') },
        }),
      },
    ]);

    const job = makeJob({
      type: 'deduction_report',
      employerId: 'employer-xyz',
      periodLabel: 'marzo 2026',
    });

    await expect(mockProcessor(job)).resolves.toBeUndefined();
  });

  it('throws when employerId is missing', async () => {
    const job = makeJob({ type: 'deduction_report' });
    await expect(mockProcessor(job)).rejects.toThrow('employerId required');
  });
});

describe('pdfWorker — portfolio_report', () => {
  it('processes a portfolio_report job with empty loans', async () => {
    __setQueryDocs([]);

    const job = makeJob({
      type: 'portfolio_report',
      month: '2026-03',
    });

    // The portfolio report queries all loans via db.collection('loans').get()
    // With empty query docs, it should still succeed
    await expect(mockProcessor(job)).resolves.toBeUndefined();
  });
});

describe('pdfWorker — unknown type', () => {
  it('handles unknown job type without throwing', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    const job = makeJob({ type: 'unknown_type' });
    await expect(mockProcessor(job)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown job type'));
    consoleSpy.mockRestore();
  });
});
