jest.mock('../../utils/rateLimiter', () => {
  const checkRateLimit = jest.fn(async () => true);
  return {
    checkRateLimit,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enforceRateLimit: require('../../__mocks__/utils/rateLimiter').makeEnforceRateLimit(
      checkRateLimit
    ),
  };
});

import { sendVerificationEmail } from '../sendVerificationEmail';
import { checkRateLimit } from '../../utils/rateLimiter';
import { _mockUsers, mockGetUser } from '../../__mocks__/firebase-admin/auth';

type Handler = (req: { auth?: { uid: string } }) => Promise<Record<string, unknown>>;
const fn = sendVerificationEmail as unknown as Handler;

const mockCheck = checkRateLimit as jest.MockedFunction<typeof checkRateLimit>;

beforeEach(() => {
  jest.clearAllMocks();
  mockCheck.mockResolvedValue(true);
  for (const key of Object.keys(_mockUsers)) delete _mockUsers[key];
});

describe('sendVerificationEmail', () => {
  describe('authentication', () => {
    it('throws unauthenticated when no auth', async () => {
      await expect(fn({})).rejects.toMatchObject({ code: 'unauthenticated' });
    });
  });

  describe('already-verified fast path', () => {
    it('reports alreadyVerified and does not attempt a send', async () => {
      _mockUsers['u1'] = { uid: 'u1', email: 'a@test.com', emailVerified: true };
      await expect(fn({ auth: { uid: 'u1' } })).resolves.toEqual({ alreadyVerified: true });
    });
  });

  describe('does not claim success it cannot deliver', () => {
    // The handler generates no verification link and hands nothing to any
    // mail transport — its body is comments and a `return`. Reporting
    // `sent: true` to the client tells the caller an email is on its way when
    // none is. A client that trusts this response shows the borrower "check
    // your inbox" for a message that will never arrive, and the borrower is
    // left permanently unable to verify with no error anywhere.
    it('must not return sent:true while no email is actually sent', async () => {
      _mockUsers['u2'] = { uid: 'u2', email: 'b@test.com', emailVerified: false };

      await expect(fn({ auth: { uid: 'u2' } })).rejects.toMatchObject({
        code: 'unimplemented',
      });
    });
  });

  describe('rate limiting', () => {
    it('throws resource-exhausted when over the limit', async () => {
      _mockUsers['u3'] = { uid: 'u3', email: 'c@test.com', emailVerified: false };
      mockCheck.mockResolvedValue(false);

      await expect(fn({ auth: { uid: 'u3' } })).rejects.toMatchObject({
        code: 'resource-exhausted',
      });
      // Refused before the handler spends a Firebase Admin getUser call.
      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('fails open when the limiter itself is unavailable', async () => {
      // Deliberate, and narrower than it looks: the only side effect this
      // handler has left is an Admin SDK read. Per the failure-mode doctrine
      // in utils/rateLimiter, 'open' is for limits that protect capacity
      // rather than money or secrets. A Redis blip must not become a
      // verification lockout. This flips to fail-closed the day the handler
      // actually sends mail — see the note in sendVerificationEmail.ts.
      _mockUsers['u4'] = { uid: 'u4', email: 'd@test.com', emailVerified: true };
      mockCheck.mockRejectedValue(new Error('redis down'));

      await expect(fn({ auth: { uid: 'u4' } })).resolves.toEqual({ alreadyVerified: true });
    });
  });
});
