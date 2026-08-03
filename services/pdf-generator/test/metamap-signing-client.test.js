const path = require('path');

const CLIENT_PATH = path.join(__dirname, '..', 'src', 'metamap-signing-client');

function freshLoad() {
  delete require.cache[require.resolve(CLIENT_PATH)];
  return require(CLIENT_PATH);
}

describe('metamap-signing-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('isEnabled() returns false when METAMAP_SIGNING_ENABLED is unset', () => {
    delete process.env.METAMAP_SIGNING_ENABLED;
    const client = freshLoad();
    expect(client.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when METAMAP_SIGNING_ENABLED=false', () => {
    process.env.METAMAP_SIGNING_ENABLED = 'false';
    const client = freshLoad();
    expect(client.isEnabled()).toBe(false);
  });

  test('isEnabled() returns true when METAMAP_SIGNING_ENABLED=true', () => {
    process.env.METAMAP_SIGNING_ENABLED = 'true';
    const client = freshLoad();
    expect(client.isEnabled()).toBe(true);
  });

  test('createSignedDocument() throws when metamapVerificationId is null', async () => {
    const client = freshLoad();
    await expect(
      client.createSignedDocument({
        loanId: 'loan-123',
        metamapVerificationId: null,
        pdfBase64: 'abc',
        signerEmail: 'a@b.com',
        signerName: 'Jane',
      }),
    ).rejects.toThrow(/metamapVerificationId required/);
  });

  test('createSignedDocument() throws clean error when credentials missing', async () => {
    delete process.env.METAMAP_CLIENT_ID;
    delete process.env.METAMAP_CLIENT_SECRET;
    const client = freshLoad();
    client._resetTokenCache();
    await expect(
      client.createSignedDocument({
        loanId: 'loan-123',
        metamapVerificationId: 'verif-abc',
        pdfBase64: 'abc',
        signerEmail: 'a@b.com',
        signerName: 'Jane',
      }),
    ).rejects.toThrow(/credentials not configured/);
  });
});
