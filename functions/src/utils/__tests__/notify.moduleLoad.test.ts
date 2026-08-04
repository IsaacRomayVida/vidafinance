// Deliberately does NOT mock 'twilio' or '@sendgrid/mail': this file exercises
// notify.ts's module-level initialization against the real Twilio SDK
// constructor, whose credential validation runs synchronously at import time.
const ORIGINAL_ENV = process.env;

describe('notify.ts module-level Twilio client construction (real SDK)', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does not throw at import time when TWILIO_ACCOUNT_SID is malformed (would otherwise crash every function in index.ts)', () => {
    // The real twilio SDK throws synchronously from its constructor when
    // accountSid is truthy but doesn't start with "AC" — a realistic
    // misconfiguration (wrong secret, truncated value, or an API-key SID used
    // without the paired `accountSid` option). notify.ts constructs its
    // client at module scope, and notify.ts is imported at the top of
    // index.ts, which defines every Cloud Function in the deployment. An
    // unguarded throw here is a total outage of the whole app, not just a
    // lost notification.
    expect(() => {
      jest.isolateModules(() => {
        process.env = {
          ...ORIGINAL_ENV,
          TWILIO_ACCOUNT_SID: 'not-a-valid-sid',
          TWILIO_AUTH_TOKEN: 'fake-auth-token',
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../notify');
      });
    }).not.toThrow();
  });
});
