import { setBaseEnv } from './testEnv';
setBaseEnv();

const mockSendWhatsApp = jest.fn().mockResolvedValue(undefined);
const mockSendSMS = jest.fn().mockResolvedValue(undefined);
const mockSendEmail = jest.fn().mockResolvedValue(undefined);
const mockGetUser = jest.fn();
const mockGetLoan = jest.fn();

jest.mock('../src/services/twilioService', () => ({
  TwilioService: jest.fn().mockImplementation(() => ({
    sendWhatsApp: mockSendWhatsApp,
    sendSMS: mockSendSMS,
  })),
}));
jest.mock('../src/services/sendgridService', () => ({
  SendGridService: jest.fn().mockImplementation(() => ({
    sendEmail: mockSendEmail,
  })),
}));
jest.mock('../src/services/firestoreService', () => ({
  FirestoreService: jest.fn().mockImplementation(() => ({
    getUser: mockGetUser,
    getLoan: mockGetLoan,
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notificationWorker } = require('../src/workers/notificationWorker');

function job(data: Record<string, unknown>) {
  return { id: 'job_1', data };
}

beforeEach(() => {
  mockSendWhatsApp.mockClear().mockResolvedValue(undefined);
  mockSendSMS.mockClear().mockResolvedValue(undefined);
  mockSendEmail.mockClear().mockResolvedValue(undefined);
  mockGetUser.mockReset();
  mockGetLoan.mockReset();
});

describe('notificationWorker — phone-based job types', () => {
  test('loan_requested sends a WhatsApp message using the inline phone', async () => {
    await notificationWorker.processor(job({ type: 'loan_requested', phone: '5512345678', amount: 1000 }));
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsApp.mock.calls[0][0]).toBe('5512345678');
    expect(mockSendWhatsApp.mock.calls[0][1]).toMatch(/1,000\.00 MXN/);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  test('loan_approved resolves the phone via Firestore when no inline phone is given', async () => {
    mockGetUser.mockResolvedValue({ phone: '5587654321', email: 'a@b.com' });
    await notificationWorker.processor(job({ type: 'loan_approved', userId: 'user_1', amount: 500 }));

    expect(mockGetUser).toHaveBeenCalledWith('user_1', ['phone']);
    expect(mockSendWhatsApp).toHaveBeenCalledWith('5587654321', expect.stringMatching(/APROBADO/));
  });

  test('loan_approved falls back to employeeId (legacy producers) when userId is absent', async () => {
    mockGetUser.mockResolvedValue({ phone: '5511112222', email: 'a@b.com' });
    await notificationWorker.processor(job({ type: 'loan_approved', employeeId: 'emp_1', amount: 500 }));
    expect(mockGetUser).toHaveBeenCalledWith('emp_1', ['phone']);
  });

  test('loan_rejected includes the rejection reason when present', async () => {
    await notificationWorker.processor(
      job({ type: 'loan_rejected', phone: '5512345678', rejectionReason: 'Score insuficiente' }),
    );
    expect(mockSendWhatsApp.mock.calls[0][1]).toMatch(/Score insuficiente/);
  });

  test('loan_rejected omits the reason line when none is given', async () => {
    await notificationWorker.processor(job({ type: 'loan_rejected', phone: '5512345678' }));
    expect(mockSendWhatsApp.mock.calls[0][1]).not.toMatch(/Motivo/);
  });

  test('loan_disbursed sends both a WhatsApp message and an SMS', async () => {
    await notificationWorker.processor(
      job({ type: 'loan_disbursed', phone: '5512345678', amount: 1000, dueDate: '2026-09-01' }),
    );
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
  });

  test('loan_disbursed fetches dueDate from Firestore when missing from the job and present on the loan', async () => {
    mockGetLoan.mockResolvedValue({ dueDate: { _seconds: 1735689600 } });
    await notificationWorker.processor(
      job({ type: 'loan_disbursed', phone: '5512345678', amount: 1000, loanId: 'loan_1' }),
    );
    expect(mockGetLoan).toHaveBeenCalledWith('loan_1');
    expect(mockSendWhatsApp.mock.calls[0][1]).not.toMatch(/tu próxima quincena/);
  });

  test('loan_disbursed falls back to a generic due-date phrase when Firestore lookup fails', async () => {
    mockGetLoan.mockRejectedValue(new Error('not found'));
    await notificationWorker.processor(
      job({ type: 'loan_disbursed', phone: '5512345678', amount: 1000, loanId: 'loan_missing' }),
    );
    expect(mockSendWhatsApp.mock.calls[0][1]).toMatch(/tu próxima quincena/);
  });

  test.each(['loan_repaid', 'loan_paid', 'loan_paid_payroll'])('%s sends the liquidation WhatsApp message', async (type) => {
    await notificationWorker.processor(job({ type, phone: '5512345678' }));
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
  });

  test.each(['loan_overdue_reminder', 'loan_overdue'])('%s sends an SMS, not WhatsApp', async (type) => {
    await notificationWorker.processor(job({ type, phone: '5512345678' }));
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
  });

  test('loan_reminder_24h sends a WhatsApp reminder', async () => {
    await notificationWorker.processor(job({ type: 'loan_reminder_24h', phone: '5512345678', amount: 300 }));
    expect(mockSendWhatsApp).toHaveBeenCalledTimes(1);
  });
});

describe('notificationWorker — email job types', () => {
  test.each(['employer_approved', 'employer_activated'])(
    '%s sends via adminContactEmail when present',
    async (type) => {
      await notificationWorker.processor(
        job({ type, adminContactEmail: 'admin@acme.mx', companyName: 'Acme', employerCode: 'ACME1' }),
      );
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'admin@acme.mx', templateId: 'd-employer-approved' }),
      );
    },
  );

  test('employer_approved falls back to the legacy `email` field when adminContactEmail is absent', async () => {
    await notificationWorker.processor(job({ type: 'employer_approved', email: 'legacy@acme.mx', companyName: 'Acme' }));
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'legacy@acme.mx' }));
  });

  test('employer_approved with neither adminContactEmail nor email logs and skips — no crash, no send', async () => {
    await expect(notificationWorker.processor(job({ type: 'employer_approved', companyName: 'Acme' }))).resolves.toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('employer_rejected sends with the rejection reason', async () => {
    await notificationWorker.processor(
      job({ type: 'employer_rejected', adminContactEmail: 'admin@acme.mx', companyName: 'Acme', rejectionReason: 'Documentos incompletos' }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'd-employer-rejected', dynamicData: expect.objectContaining({ rejectionReason: 'Documentos incompletos' }) }),
    );
  });
});

describe('notificationWorker — malformed / unknown payloads', () => {
  test('an unrecognized job type is a no-op: resolves without calling any provider', async () => {
    await expect(notificationWorker.processor(job({ type: 'not_a_real_type' }))).resolves.toBeUndefined();
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockSendSMS).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('a phone-required job with neither phone, userId, nor employeeId rejects with a clear error', async () => {
    await expect(notificationWorker.processor(job({ type: 'loan_approved', amount: 500 }))).rejects.toThrow(
      /No userId\/employeeId in job data/,
    );
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
  });

  test('resolvePhone propagates a Firestore lookup failure (user not found) instead of swallowing it', async () => {
    mockGetUser.mockRejectedValue(new Error('User ghost not found in employees or users collections'));
    await expect(
      notificationWorker.processor(job({ type: 'loan_approved', userId: 'ghost', amount: 500 })),
    ).rejects.toThrow(/User ghost not found/);
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
  });
});

describe('notificationWorker — provider failure does not silently swallow', () => {
  test('a Twilio failure on loan_approved rejects the job (job processor throws)', async () => {
    mockSendWhatsApp.mockRejectedValue(new Error('Twilio 21211: invalid to number'));
    await expect(
      notificationWorker.processor(job({ type: 'loan_approved', phone: '5512345678', amount: 500 })),
    ).rejects.toThrow(/invalid to number/);
  });

  test('a Twilio failure on one leg of loan_disbursed (Promise.all) still rejects the job', async () => {
    mockSendSMS.mockRejectedValue(new Error('Twilio 20003: authentication failed'));
    await expect(
      notificationWorker.processor(job({ type: 'loan_disbursed', phone: '5512345678', amount: 500, dueDate: '2026-09-01' })),
    ).rejects.toThrow(/authentication failed/);
  });

  test('a SendGrid failure on employer_approved rejects the job', async () => {
    mockSendEmail.mockRejectedValue(new Error('SendGrid 401: Unauthorized'));
    await expect(
      notificationWorker.processor(job({ type: 'employer_approved', adminContactEmail: 'a@b.com', companyName: 'Acme' })),
    ).rejects.toThrow(/Unauthorized/);
  });
});

describe('notificationWorker — completed/failed event listeners', () => {
  test('the failed listener logs without throwing, even with a partial job', async () => {
    await expect(
      notificationWorker.emit('failed', job({ type: 'loan_approved' }), new Error('boom')),
    ).resolves.toBeUndefined();
  });

  test('the completed listener logs without throwing', async () => {
    await expect(notificationWorker.emit('completed', job({ type: 'loan_approved' }))).resolves.toBeUndefined();
  });
});
