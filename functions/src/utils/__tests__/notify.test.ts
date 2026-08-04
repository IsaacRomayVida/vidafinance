// Mocks for the Twilio/SendGrid SDKs. Both real packages are plain CJS
// `module.exports = <callable/object>`, so the mock factories must mirror
// that shape exactly (no `__esModule` marker) for ts-jest's esModuleInterop
// default-import handling to line up with the real runtime behavior.
const mockMessagesCreate = jest.fn();
const mockTwilioFactory = jest.fn(() => ({ messages: { create: mockMessagesCreate } }));
jest.mock('twilio', () => mockTwilioFactory);

const mockSgSend = jest.fn();
const mockSgSetApiKey = jest.fn();
jest.mock('@sendgrid/mail', () => ({
  setApiKey: mockSgSetApiKey,
  send: mockSgSend,
}));

import type { _mockStore as MockStoreType } from '../../__mocks__/firebase-admin/firestore';

const ORIGINAL_ENV = process.env;

/**
 * Fresh import of notify.ts with a given env, matching how the module reads
 * its config once at load time. jest.isolateModules gives notify.ts its own
 * module registry, which means its transitive `firebase-admin/firestore`
 * mock is a *different instance* than one imported at the top of this file
 * — so the mock's `_mockStore` must be pulled from inside the same isolated
 * scope, not imported separately, or the two will never see each other's writes.
 */
function loadNotifyWithEnv(
  env: Record<string, string | undefined>
): typeof import('../notify') & { _mockStore: typeof MockStoreType } {
  let mod!: typeof import('../notify');
  let store!: typeof MockStoreType;
  jest.isolateModules(() => {
    process.env = { ...ORIGINAL_ENV, ...env };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../notify');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    store = require('../../__mocks__/firebase-admin/firestore')._mockStore;
  });
  return { ...mod, _mockStore: store };
}

const CONFIGURED_ENV = {
  TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  TWILIO_AUTH_TOKEN: 'fake-auth-token',
  TWILIO_FROM_NUMBER: '+15551234567',
  SENDGRID_API_KEY: 'SG.fake-key',
  SENDGRID_FROM_EMAIL: 'noreply@vidafinance.com',
};

describe('notify.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('sendSMS failure handling', () => {
    it('records a persisted trace when the Twilio send fails, instead of vanishing after a console.error', async () => {
      const { sendSMS, _mockStore } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockMessagesCreate.mockRejectedValueOnce(new Error('Twilio 500'));

      await sendSMS('+5215500000000', 'test body');

      expect(_mockStore.auditLog.length).toBeGreaterThan(0);
    });
  });

  describe('sendEmail failure handling', () => {
    it('records a persisted trace when the SendGrid send fails, instead of vanishing after a console.error', async () => {
      const { sendEmail, _mockStore } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockSgSend.mockRejectedValueOnce(new Error('SendGrid 500'));

      await sendEmail('borrower@example.com', 'subject', '<p>hi</p>');

      expect(_mockStore.auditLog.length).toBeGreaterThan(0);
    });

    it('does not hang forever when SendGrid never responds', async () => {
      jest.useFakeTimers();
      try {
        const { sendEmail } = loadNotifyWithEnv(CONFIGURED_ENV);
        mockSgSend.mockImplementationOnce(() => new Promise(() => {}));

        let settled = false;
        void sendEmail('borrower@example.com', 'subject', '<p>hi</p>').then(() => {
          settled = true;
        });

        await jest.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('HTML injection in email templates', () => {
    it('escapes an attacker-controlled employeeName before interpolating it into the email HTML', async () => {
      const { notifyLoanEvent } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockSgSend.mockResolvedValueOnce(undefined);

      await notifyLoanEvent('loan_approved', {
        employeeEmail: 'borrower@example.com',
        employeeName: '<img src=x onerror=alert(1)>',
        loanAmount: 5000,
      });

      expect(mockSgSend).toHaveBeenCalledTimes(1);
      const html = mockSgSend.mock.calls[0][0].html as string;
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('escapes an attacker-controlled rejectionReason before interpolating it into the email HTML', async () => {
      const { notifyLoanEvent } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockSgSend.mockResolvedValueOnce(undefined);

      await notifyLoanEvent('loan_rejected', {
        employeeEmail: 'borrower@example.com',
        employeeName: 'Ana',
        rejectionReason: '<script>alert(1)</script>',
      });

      const html = mockSgSend.mock.calls[0][0].html as string;
      expect(html).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('monetary amount formatting', () => {
    it('formats loanAmount as MXN currency in the approval SMS, not a bare number', async () => {
      const { notifyLoanEvent } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockMessagesCreate.mockResolvedValueOnce(undefined);

      await notifyLoanEvent('loan_approved', {
        employeePhone: '+5215500000000',
        employeeName: 'Ana',
        loanAmount: 15000.5,
      });

      const smsBody = mockMessagesCreate.mock.calls[0][0].body as string;
      expect(smsBody).not.toContain('15000.5');
      expect(smsBody).toMatch(/\$15,000\.50/);
    });

    it('formats amountDue as MXN currency in the overdue email, not a bare number', async () => {
      const { notifyLoanEvent } = loadNotifyWithEnv(CONFIGURED_ENV);
      mockSgSend.mockResolvedValueOnce(undefined);

      await notifyLoanEvent('loan_overdue', {
        employeeEmail: 'borrower@example.com',
        employeeName: 'Ana',
        amountDue: 2500,
      });

      const html = mockSgSend.mock.calls[0][0].html as string;
      expect(html).not.toMatch(/>2500</);
      expect(html).toMatch(/\$2,500\.00/);
    });
  });
});
