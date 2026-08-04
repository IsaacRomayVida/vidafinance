import { setAdminClaim, revokeAdminClaim } from '../adminClaims';
import { _mockStore, mockDb } from '../../__mocks__/firebase-admin/firestore';
import { _mockUsers, mockGetUser, mockSetCustomUserClaims } from '../../__mocks__/firebase-admin/auth';

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
  for (const uid of Object.keys(_mockUsers)) delete _mockUsers[uid];
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

// ── super_admin is above admin, and both callables have to know it ────────────
//
// Both are gated on ['admin', 'super_admin'] and neither looked at what the
// TARGET already was, so an `admin` could hand a `super_admin` a
// `{ role: 'employee' }` claim and the reserve role stopped existing. `admin` is
// grantable in-product by any other admin, and a stale legacy `admin: true`
// token resolves to it too — so one compromised admin account was enough to
// leave the product with no role above the attacker's, recoverable only by an
// operator running scripts/bootstrap-super-admin.js out of band.
describe('super_admin targets', () => {
  const legacyAdminAuth = {
    uid: 'legacy-uid',
    // No `role` claim at all — the pre-a23963f grant shape. authMiddleware
    // resolves it to `admin`, which is exactly what satisfies these gates.
    token: { admin: true, email: 'legacy@test.com' },
  };

  /** A super_admin as the bootstrap script leaves them: claim AND mirror. */
  const seedSuperAdminTarget = (uid: string) => {
    _mockUsers[uid] = {
      uid,
      email: `${uid}@test.com`,
      emailVerified: true,
      customClaims: { role: 'super_admin' },
    };
    _mockStore.users[uid] = { exists: true, data: { role: 'super_admin' } };
  };

  it('refuses an admin revoking a super_admin', async () => {
    seedSuperAdminTarget('super-target');

    await expect(
      revokeFn({ auth: adminAuth, data: { targetUid: 'super-target' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  it('refuses an admin demoting a super_admin through setAdminClaim', async () => {
    seedSuperAdminTarget('super-target');

    await expect(
      setFn({ auth: adminAuth, data: { targetUid: 'super-target', role: 'employee' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  it('refuses a legacy `admin: true` token demoting a super_admin', async () => {
    seedSuperAdminTarget('super-target');

    await expect(
      setFn({ auth: legacyAdminAuth, data: { targetUid: 'super-target', role: 'ops' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  // The claim is authoritative, so a target carrying it must be refused even
  // when the users/{uid} mirror was never written or has gone stale.
  it('refuses on the custom claim alone, with no users/{uid} mirror', async () => {
    _mockUsers['super-target'] = {
      uid: 'super-target',
      email: 'super-target@test.com',
      emailVerified: true,
      customClaims: { role: 'super_admin' },
    };

    await expect(
      revokeFn({ auth: adminAuth, data: { targetUid: 'super-target' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  // And the other way round: a mirror that says super_admin is enough on its
  // own. Under-reading the target's role here costs someone their access.
  it('refuses on the users/{uid} mirror alone, with no custom claim', async () => {
    _mockStore.users['super-target'] = { exists: true, data: { role: 'super_admin' } };

    await expect(
      revokeFn({ auth: adminAuth, data: { targetUid: 'super-target' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  // A refusal must not leave the console showing a role the claim never lost.
  it('leaves the users/{uid} mirror untouched when it refuses', async () => {
    seedSuperAdminTarget('super-target');

    await expect(
      revokeFn({ auth: adminAuth, data: { targetUid: 'super-target' } })
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(mockDb.runTransaction).not.toHaveBeenCalled();
    expect(_mockStore.users['super-target'].data).toEqual({ role: 'super_admin' });
  });

  it('still lets a super_admin revoke another super_admin', async () => {
    seedSuperAdminTarget('super-target');

    const result = await revokeFn({ auth: superAdminAuth, data: { targetUid: 'super-target' } });

    expect(result).toMatchObject({ success: true, role: 'employee' });
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith('super-target', { role: 'employee' });
  });

  // The self-guard used to compare against the literal 'admin', so a
  // super_admin could hand themselves `role: 'admin'` and drop the one role
  // this API cannot grant back.
  it('refuses a super_admin self-demoting to admin', async () => {
    _mockUsers['super-uid'] = {
      uid: 'super-uid',
      email: 'super@test.com',
      emailVerified: true,
      customClaims: { role: 'super_admin' },
    };

    await expect(
      setFn({ auth: superAdminAuth, data: { targetUid: 'super-uid', role: 'admin' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });

  // Fail closed: an unreadable target role is not an absent one.
  it('refuses when the target user record cannot be read', async () => {
    mockGetUser.mockRejectedValueOnce(new Error('auth/user-not-found'));

    await expect(
      revokeFn({ auth: adminAuth, data: { targetUid: 'ghost' } })
    ).rejects.toMatchObject({ code: 'not-found' });

    expect(mockSetCustomUserClaims).not.toHaveBeenCalled();
  });
});
