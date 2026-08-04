export const mockSetCustomUserClaims = jest.fn(async () => {});

export interface MockUserRecord {
  uid: string;
  email?: string;
  emailVerified: boolean;
}

// Suites that exercise auth handlers set `_mockUsers[uid]` (or override
// `getUserImpl`) before calling in. Default is an unverified user so the
// common "needs verification" path is the one under test.
export const _mockUsers: Record<string, MockUserRecord> = {};

export const mockGetUser = jest.fn(async (uid: string): Promise<MockUserRecord> => {
  const user = _mockUsers[uid];
  if (!user) {
    return { uid, email: `${uid}@test.com`, emailVerified: false };
  }
  return user;
});

export const mockGenerateEmailVerificationLink = jest.fn(
  async (email: string) => `https://vida.test/verify?email=${encodeURIComponent(email)}`
);

const mockAuth = {
  setCustomUserClaims: mockSetCustomUserClaims,
  getUser: mockGetUser,
  generateEmailVerificationLink: mockGenerateEmailVerificationLink,
};

export const getAuth = jest.fn(() => mockAuth);
