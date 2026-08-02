import { withAuth, validateAuth, AuthContext } from '../authMiddleware';

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

/** Captures the AuthContext the wrapped handler was invoked with. */
function makeHandler() {
  const seen: AuthContext[] = [];
  const handler = jest.fn(async (_data: unknown, auth: AuthContext) => {
    seen.push(auth);
    return { ok: true };
  });
  return { handler, seen };
}

function call(requiredRoles: string[], token: Record<string, unknown>) {
  const { handler, seen } = makeHandler();
  const wrapped = withAuth(requiredRoles, handler);
  return {
    seen,
    handler,
    run: () => wrapped({ auth: { uid: 'uid-1', token }, data: {} }),
  };
}

const LEGACY_TOKEN = { admin: true, email: 'legacy@example.com' };

describe('withAuth — legacy `admin: true` boolean claim', () => {
  // The defect: a legacy boolean token satisfied ANY gate whose required-role
  // list mentioned any of admin | super_admin | ops. It must now behave as
  // exactly one role — 'admin' — and nothing more.

  it('REJECTS a legacy admin token against a super_admin-only gate', async () => {
    const { run, handler } = call(['super_admin'], LEGACY_TOKEN);
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('REJECTS a legacy admin token against an ops-only gate', async () => {
    const { run, handler } = call(['ops'], LEGACY_TOKEN);
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ACCEPTS a legacy admin token against an admin gate (no access regression)', async () => {
    const { run, seen } = call(['admin'], LEGACY_TOKEN);
    await expect(run()).resolves.toEqual({ ok: true });
    expect(seen[0]!.role).toBe('admin');
  });

  it('ACCEPTS a legacy admin token against a gate that lists admin among others', async () => {
    const { run, seen } = call(['ops', 'admin', 'super_admin'], LEGACY_TOKEN);
    await expect(run()).resolves.toEqual({ ok: true });
    expect(seen[0]!.role).toBe('admin');
  });

  it('REJECTS a legacy admin token against an employee-only gate', async () => {
    const { run } = call(['employee'], LEGACY_TOKEN);
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('records actorRole as admin — never super_admin — for a legacy token', async () => {
    const { run, seen } = call(['admin', 'super_admin'], LEGACY_TOKEN);
    await run();
    expect(seen[0]!.role).toBe('admin');
    expect(seen[0]!.role).not.toBe('super_admin');
  });

  it('lets an explicit role claim override a stale admin boolean (no privilege ride)', async () => {
    // A principal demoted to employee whose token still carries admin: true
    // must not reach an admin gate.
    const { run, handler } = call(['admin'], { admin: true, role: 'employee' });
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not let a stale admin boolean inflate the audited role', async () => {
    const { run, seen } = call(['employee'], { admin: true, role: 'employee' });
    await run();
    expect(seen[0]!.role).toBe('employee');
  });
});

describe('withAuth — genuine role claims', () => {
  it('accepts a genuine super_admin against a super_admin gate', async () => {
    const { run, seen } = call(['super_admin'], { role: 'super_admin' });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(seen[0]!.role).toBe('super_admin');
  });

  it('accepts a genuine ops against an ops gate', async () => {
    const { run, seen } = call(['ops', 'admin', 'super_admin'], { role: 'ops' });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(seen[0]!.role).toBe('ops');
  });

  it('rejects a genuine admin against a super_admin-only gate', async () => {
    const { run } = call(['super_admin'], { role: 'admin' });
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects an employee against an admin gate', async () => {
    const { run } = call(['admin', 'super_admin'], { role: 'employee' });
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('withAuth — tokens with no role at all', () => {
  it('rejects a no-claim token against an admin gate', async () => {
    const { run } = call(['admin', 'super_admin'], { email: 'nobody@example.com' });
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a token with admin: false against an admin gate', async () => {
    const { run } = call(['admin'], { admin: false });
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('defaults a no-claim token to employee on an open gate', async () => {
    const { run, seen } = call([], { email: 'nobody@example.com' });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(seen[0]!.role).toBe('employee');
  });

  it('still requires authentication', async () => {
    const { handler } = makeHandler();
    const wrapped = withAuth(['admin'], handler);
    await expect(wrapped({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('validateAuth — undefined-role bypass (REST path)', () => {
  beforeEach(() => {
    mockVerifyIdToken.mockReset();
  });

  const req = { headers: { authorization: 'Bearer tok' } };

  it('REJECTS a token with no role claim against a required-role list', async () => {
    // Previously the `role &&` guard skipped the check entirely and admitted
    // the caller with a defaulted 'employee' role.
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c' });
    await expect(validateAuth(req, ['admin', 'super_admin'])).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('REJECTS a legacy boolean token against a super_admin-only gate', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c', admin: true });
    await expect(validateAuth(req, ['super_admin'])).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('accepts a legacy boolean token against an admin gate, as role admin', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c', admin: true });
    await expect(validateAuth(req, ['admin'])).resolves.toMatchObject({ role: 'admin' });
  });

  it('accepts a genuine role match', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c', role: 'ops' });
    await expect(validateAuth(req, ['ops'])).resolves.toMatchObject({ role: 'ops' });
  });

  it('rejects a mismatched genuine role', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c', role: 'employee' });
    await expect(validateAuth(req, ['admin'])).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('admits a role-less token as employee when no roles are required', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u1', email: 'a@b.c' });
    await expect(validateAuth(req)).resolves.toMatchObject({ role: 'employee' });
  });

  it('rejects a missing authorization header', async () => {
    await expect(validateAuth({ headers: {} }, ['admin'])).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('maps a revoked token to unauthenticated', async () => {
    mockVerifyIdToken.mockRejectedValue({ code: 'auth/id-token-revoked' });
    await expect(validateAuth(req, ['admin'])).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'Token revoked',
    });
  });
});
