import { getContractDownloadUrl } from '../getContractDownloadUrl';
import { _mockStore } from '../../__mocks__/firebase-admin/firestore';
import { _mockStorage } from '../../__mocks__/firebase-admin/storage';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;
const fn = getContractDownloadUrl as unknown as Handler;

const loanId = 'loan-abc';

const employeeAuth = {
  uid: 'emp-owner',
  token: { role: 'employee', email: 'e@test.com' },
};

const otherEmployeeAuth = {
  uid: 'emp-other',
  token: { role: 'employee', email: 'other@test.com' },
};

const employerAdminAuth = {
  uid: 'employer-admin-1',
  token: { role: 'employer_admin', email: 'ea@test.com', employerId: 'employer-123' },
};

const opsAuth = {
  uid: 'ops-uid',
  token: { role: 'ops', email: 'ops@test.com' },
};

const loanDoc = {
  exists: true,
  data: {
    status: 'disbursed',
    employeeId: 'emp-owner',
    employerId: 'employer-123',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.loans = {};
  _mockStorage.files = [];
  _mockStorage.signedUrl = 'https://storage.googleapis.com/signed-url-mock';
  delete _mockStorage.getFilesImpl;
  delete _mockStorage.getSignedUrlImpl;
});

describe('getContractDownloadUrl', () => {
  describe('authentication', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(fn({ data: { loanId } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });
  });

  describe('input validation', () => {
    it('throws invalid-argument when loanId is missing', async () => {
      await expect(
        fn({ auth: employeeAuth, data: {} })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('throws invalid-argument when loanId is empty', async () => {
      await expect(
        fn({ auth: employeeAuth, data: { loanId: '' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('authorization', () => {
    it('allows the loan-owning employee', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      const result = (await fn({
        auth: employeeAuth,
        data: { loanId },
      })) as Record<string, unknown>;
      expect(result.url).toBe('https://storage.googleapis.com/signed-url-mock');
      expect(result.contractFilename).toBe(`loans/${loanId}/contrato_20260101.pdf`);
      expect(typeof result.expiresAt).toBe('string');
    });

    it('allows the loan-owning employee via employeeUid field', async () => {
      _mockStore.loans[loanId] = {
        exists: true,
        data: {
          employeeUid: 'emp-owner',
          employerId: 'employer-123',
          status: 'disbursed',
        },
      };
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      const result = (await fn({
        auth: employeeAuth,
        data: { loanId },
      })) as Record<string, unknown>;
      expect(result.url).toBeDefined();
    });

    it('denies a different employee who does not own the loan', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      await expect(
        fn({ auth: otherEmployeeAuth, data: { loanId } })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows the employer_admin for the loan employer', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      const result = (await fn({
        auth: employerAdminAuth,
        data: { loanId },
      })) as Record<string, unknown>;
      expect(result.url).toBeDefined();
    });

    it('denies an employer_admin for a different employer', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      await expect(
        fn({
          auth: {
            uid: 'ea-other',
            token: {
              role: 'employer_admin',
              email: 'x@test.com',
              employerId: 'employer-999',
            },
          },
          data: { loanId },
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows ops role', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      const result = (await fn({ auth: opsAuth, data: { loanId } })) as Record<string, unknown>;
      expect(result.url).toBeDefined();
    });

    // The employer branch compares `loan.employerId` against the caller's
    // `employerId` CLAIM, and both are routinely absent: nothing in this repo
    // mints an employerId claim (every setCustomUserClaims call site writes
    // `{ role }` only), and a loan document can reach this handler without an
    // employerId. `undefined === undefined` was true, so any employer_admin —
    // including one belonging to a completely unrelated company — was handed a
    // 15-minute signed URL to that borrower's contract PDF.
    describe('employer_admin with no employerId claim (the production claim shape)', () => {
      const claimlessEmployerAdmin = {
        uid: 'employer-123',
        token: { role: 'employer_admin', email: 'ea@test.com' },
      };

      it('denies when the loan document has no employerId', async () => {
        _mockStore.loans[loanId] = {
          exists: true,
          data: { status: 'disbursed', employeeId: 'emp-owner' },
        };
        _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
        await expect(
          fn({ auth: claimlessEmployerAdmin, data: { loanId } })
        ).rejects.toMatchObject({ code: 'permission-denied' });
      });

      it('denies when the loan document carries an empty employerId', async () => {
        _mockStore.loans[loanId] = {
          exists: true,
          data: { status: 'disbursed', employeeId: 'emp-owner', employerId: '' },
        };
        _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
        await expect(
          fn({ auth: claimlessEmployerAdmin, data: { loanId } })
        ).rejects.toMatchObject({ code: 'permission-denied' });
      });

      it('denies an unrelated employer_admin a normal loan they do not own', async () => {
        _mockStore.loans[loanId] = loanDoc;
        _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
        await expect(
          fn({
            auth: { uid: 'ea-unrelated', token: { role: 'employer_admin', email: 'u@test.com' } },
            data: { loanId },
          })
        ).rejects.toMatchObject({ code: 'permission-denied' });
      });
    });

    it('denies an ordinary employee a loan whose employerId is missing', async () => {
      _mockStore.loans[loanId] = {
        exists: true,
        data: { status: 'disbursed', employeeId: 'emp-owner' },
      };
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      await expect(
        fn({ auth: otherEmployeeAuth, data: { loanId } })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  describe('business logic', () => {
    it('throws not-found when loan does not exist', async () => {
      await expect(
        fn({ auth: opsAuth, data: { loanId: 'nonexistent' } })
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('throws not-found when no contract files exist', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [];
      await expect(
        fn({ auth: employeeAuth, data: { loanId } })
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('returns the most recent contract when multiple versions exist', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [
        { name: `loans/${loanId}/contrato_20260101T000000.pdf` },
        { name: `loans/${loanId}/contrato_20260315T120000.pdf` },
        { name: `loans/${loanId}/contrato_20260210T000000.pdf` },
      ];
      const result = (await fn({
        auth: employeeAuth,
        data: { loanId },
      })) as Record<string, unknown>;
      expect(result.contractFilename).toBe(
        `loans/${loanId}/contrato_20260315T120000.pdf`
      );
    });

    it('returns an expiresAt within ~15 minutes', async () => {
      _mockStore.loans[loanId] = loanDoc;
      _mockStorage.files = [{ name: `loans/${loanId}/contrato_20260101.pdf` }];
      const before = Date.now();
      const result = (await fn({
        auth: employeeAuth,
        data: { loanId },
      })) as Record<string, unknown>;
      const expiry = new Date(result.expiresAt as string).getTime();
      expect(expiry).toBeGreaterThanOrEqual(before + 14 * 60 * 1000);
      expect(expiry).toBeLessThanOrEqual(before + 15 * 60 * 1000 + 1000);
    });
  });
});
