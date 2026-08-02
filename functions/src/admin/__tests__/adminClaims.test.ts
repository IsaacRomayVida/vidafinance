import { setAdminClaim, revokeAdminClaim } from '../adminClaims';
import { _mockStore, mockDb } from '../../__mocks__/firebase-admin/firestore';
import { mockSetCustomUserClaims } from '../../__mocks__/firebase-admin/auth';

type Handler = (req: { auth?: unknown; data: unknown }) => Promise<unknown>;

const setFn = setAdminClaim as unknown as Handler;
const revokeFn = revokeAdminClaim as unknown as Handler;

const adminAuth = {
  uid: 'admin-uid',
  token: { role: 'admin', email: 'admin@test.com' },
};

const superAdminAuth = {
  uid: 'super-uid',
  token: { role: 'super_admin', email: 'super@test.com' },
};

beforeEach(() => {
  jest.clearAllMocks();
  _mockStore.users = {};
  _mockStore.auditLog = [];
  mockSetCustomUserClaims.mockResolvedValue(undefined);
});

describe('setAdminClaim', () => {
  describe('authentication & authorization', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(setFn({ data: { targetUid: 'user-1', role: 'ops' } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('throws permission-denied for employee role', async () => {
      await expect(
        setFn({
          auth: { uid: 'emp', token: { role: 'employee', email: 'e@test.com' } },
          data: { targetUid: 'user-1', role: 'ops' },
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('throws permission-denied for ops role', async () => {
      await expect(
        setFn({
          auth: { uid: 'ops', token: { role: 'ops', email: 'ops@test.com' } },
          data: { targetUid: 'user-1', role: 'ops' },
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows admin role', async () => {
      const result = await setFn({
        auth: adminAuth,
        data: { targetUid: 'user-1', role: 'ops' },
      });
      expect(result).toMatchObject({ success: true });
    });

    it('allows super_admin role', async () => {
      const result = await setFn({
        auth: superAdminAuth,
        data: { targetUid: 'user-1', role: 'ops' },
      });
      expect(result).toMatchObject({ success: true });
    });
  });

  describe('input validation', () => {
    it('throws invalid-argument when targetUid is missing', async () => {
      await expect(
        setFn({ auth: adminAuth, data: { role: 'ops' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('throws invalid-argument when role is invalid', async () => {
      await expect(
        setFn({ auth: adminAuth, data: { targetUid: 'user-1', role: 'hacker' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('throws invalid-argument when role is super_admin (not allowed in schema)', async () => {
      await expect(
        setFn({ auth: adminAuth, data: { targetUid: 'user-1', role: 'super_admin' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('business logic', () => {
    it('throws failed-precondition on self-demotion (admin changing own role to non-admin)', async () => {
      await expect(
        setFn({
          auth: adminAuth,
          data: { targetUid: 'admin-uid', role: 'employee' },
        })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    it('allows admin to keep own admin role', async () => {
      const result = await setFn({
        auth: adminAuth,
        data: { targetUid: 'admin-uid', role: 'admin' },
      });
      expect(result).toMatchObject({ success: true, role: 'admin' });
    });

    it('calls setCustomUserClaims with correct role', async () => {
      await setFn({ auth: adminAuth, data: { targetUid: 'user-1', role: 'ops' } });
      expect(mockSetCustomUserClaims).toHaveBeenCalledWith('user-1', { role: 'ops' });
    });

    it('returns targetUid and role', async () => {
      const result = (await setFn({
        auth: adminAuth,
        data: { targetUid: 'user-1', role: 'employee' },
      })) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.targetUid).toBe('user-1');
      expect(result.role).toBe('employee');
    });

    it('writes audit log to the readable audit_log collection', async () => {
      await setFn({ auth: adminAuth, data: { targetUid: 'user-2', role: 'ops' } });
      expect(_mockStore.auditLog.length).toBeGreaterThanOrEqual(1);
      const log = _mockStore.auditLog[0] as Record<string, unknown>;
      expect(log['action']).toBe('admin.setRole');
      expect(log['targetId']).toBe('user-2');
      expect(log['actorUid']).toBe('admin-uid');
      expect(log['actorEmail']).toBe('admin@test.com');
      expect(log['targetCollection']).toBe('admin');
      expect(log['after']).toEqual({ role: 'ops' });
    });

    it('does not grant the claim when the audit write fails', async () => {
      mockDb.runTransaction.mockRejectedValueOnce(new Error('audit write failed'));
      await expect(
        setFn({ auth: adminAuth, data: { targetUid: 'user-2', role: 'ops' } })
      ).rejects.toMatchObject({ code: 'internal' });
      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });

    it('propagates setCustomUserClaims errors as internal', async () => {
      mockSetCustomUserClaims.mockRejectedValue(new Error('Firebase error'));
      await expect(
        setFn({ auth: adminAuth, data: { targetUid: 'user-1', role: 'ops' } })
      ).rejects.toMatchObject({ code: 'internal' });
    });
  });
});

describe('revokeAdminClaim', () => {
  describe('authentication & authorization', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(revokeFn({ data: { targetUid: 'user-1' } })).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    });

    it('throws permission-denied for employee role', async () => {
      await expect(
        revokeFn({
          auth: { uid: 'emp', token: { role: 'employee', email: 'e@test.com' } },
          data: { targetUid: 'user-1' },
        })
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('allows admin role', async () => {
      const result = await revokeFn({ auth: adminAuth, data: { targetUid: 'user-1' } });
      expect(result).toMatchObject({ success: true });
    });

    it('allows super_admin role', async () => {
      const result = await revokeFn({ auth: superAdminAuth, data: { targetUid: 'user-1' } });
      expect(result).toMatchObject({ success: true });
    });
  });

  describe('input validation', () => {
    it('throws invalid-argument when targetUid is missing', async () => {
      await expect(revokeFn({ auth: adminAuth, data: {} })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    });

    it('throws invalid-argument when targetUid is empty string', async () => {
      await expect(
        revokeFn({ auth: adminAuth, data: { targetUid: '' } })
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    });
  });

  describe('business logic', () => {
    it('throws failed-precondition on self-revocation', async () => {
      await expect(
        revokeFn({ auth: adminAuth, data: { targetUid: 'admin-uid' } })
      ).rejects.toMatchObject({ code: 'failed-precondition' });
    });

    it('resets target to employee role via setCustomUserClaims', async () => {
      await revokeFn({ auth: adminAuth, data: { targetUid: 'user-1' } });
      expect(mockSetCustomUserClaims).toHaveBeenCalledWith('user-1', { role: 'employee' });
    });

    it('returns targetUid with role=employee', async () => {
      const result = (await revokeFn({
        auth: adminAuth,
        data: { targetUid: 'user-1' },
      })) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.targetUid).toBe('user-1');
      expect(result.role).toBe('employee');
    });

    it('writes audit log to the readable audit_log collection', async () => {
      await revokeFn({ auth: adminAuth, data: { targetUid: 'user-2' } });
      expect(_mockStore.auditLog.length).toBeGreaterThanOrEqual(1);
      const log = _mockStore.auditLog[0] as Record<string, unknown>;
      expect(log['action']).toBe('admin.revokeRole');
      expect(log['targetId']).toBe('user-2');
      expect(log['actorUid']).toBe('admin-uid');
      expect(log['targetCollection']).toBe('admin');
      expect(log['after']).toEqual({ role: 'employee' });
    });

    it('does not revoke the claim when the audit write fails', async () => {
      mockDb.runTransaction.mockRejectedValueOnce(new Error('audit write failed'));
      await expect(
        revokeFn({ auth: adminAuth, data: { targetUid: 'user-2' } })
      ).rejects.toMatchObject({ code: 'internal' });
      expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
    });

    it('propagates setCustomUserClaims errors as internal', async () => {
      mockSetCustomUserClaims.mockRejectedValue(new Error('Firebase error'));
      await expect(
        revokeFn({ auth: adminAuth, data: { targetUid: 'user-1' } })
      ).rejects.toMatchObject({ code: 'internal' });
    });
  });
});
