const crypto = require('crypto');

// ── Helpers ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret-256bit';

function sign(body) {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

function makeVerificationCompletedBody(verificationId = 'ver-abc-123', overrides = {}) {
  return {
    eventName: 'verification_completed',
    resource: `https://api.getmati.com/v2/verifications/${verificationId}`,
    flowId: '60b8fd58a87c30001b14dedd',
    timestamp: '2026-03-21T12:00:00.000Z',
    metadata: { loanId: 'vida-loan-123', correlationId: 'corr-uuid', stage: '4' },
    ...overrides,
  };
}

function makeStepCompletedBody(verificationId = 'ver-abc-123', stepId = 'document-reading') {
  return {
    eventName: 'step_completed',
    resource: `https://api.getmati.com/v2/verifications/${verificationId}`,
    flowId: '60b8fd58a87c30001b14dedd',
    timestamp: '2026-03-21T12:00:00.000Z',
    step: {
      status: 200,
      id: stepId,
      data: { fullName: 'Juan Pérez', documentNumber: 'PEGJ900101HDFRRL09' },
      error: null,
    },
    metadata: { loanId: 'vida-loan-123', correlationId: 'corr-uuid', stage: '4' },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('metamap-client parseWebhook', () => {
  let parseWebhook;

  beforeAll(() => {
    process.env.METAMAP_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Require after setting env
    parseWebhook = require('./metamap-client').parseWebhook;
  });

  afterAll(() => {
    delete process.env.METAMAP_WEBHOOK_SECRET;
  });

  it('returns valid=true for a correct signature', () => {
    const body = makeVerificationCompletedBody();
    const sig = sign(body);
    const result = parseWebhook(body, sig);

    expect(result.valid).toBe(true);
    expect(result.eventName).toBe('verification_completed');
    expect(result.verificationId).toBe('ver-abc-123');
    expect(result.metadata.loanId).toBe('vida-loan-123');
  });

  it('returns valid=false for an incorrect signature', () => {
    const body = makeVerificationCompletedBody();
    const result = parseWebhook(body, 'bad-signature');

    expect(result.valid).toBe(false);
  });

  it('returns valid=false when signature is missing', () => {
    const body = makeVerificationCompletedBody();
    const result = parseWebhook(body, undefined);

    expect(result.valid).toBe(false);
  });

  it('returns valid=false when body is null', () => {
    const result = parseWebhook(null, 'some-sig');
    expect(result.valid).toBe(false);
  });

  it('parses step_completed events correctly', () => {
    const body = makeStepCompletedBody('ver-xyz', 'facematch');
    const sig = sign(body);
    const result = parseWebhook(body, sig);

    expect(result.valid).toBe(true);
    expect(result.eventName).toBe('step_completed');
    expect(result.verificationId).toBe('ver-xyz');
    expect(result.step.id).toBe('facematch');
    expect(result.step.status).toBe(200);
  });

  it('extracts verificationId from resource URL', () => {
    const body = makeVerificationCompletedBody('my-ver-id-456');
    const sig = sign(body);
    const result = parseWebhook(body, sig);

    expect(result.verificationId).toBe('my-ver-id-456');
  });

  it('handles missing metadata gracefully', () => {
    const body = makeVerificationCompletedBody('ver-1', { metadata: undefined });
    const sig = sign(body);
    const result = parseWebhook(body, sig);

    expect(result.valid).toBe(true);
    expect(result.metadata).toBeNull();
  });

  it('rejects tampered body with valid signature from original', () => {
    const originalBody = makeVerificationCompletedBody();
    const sig = sign(originalBody);

    // Tamper with the body
    const tamperedBody = { ...originalBody, eventName: 'tampered_event' };
    const result = parseWebhook(tamperedBody, sig);

    expect(result.valid).toBe(false);
  });
});

describe('metamap-client parseWebhook without secret configured', () => {
  it('returns valid=false when METAMAP_WEBHOOK_SECRET is not set', () => {
    // Clear the require cache to reload with clean env
    delete require.cache[require.resolve('./metamap-client')];
    const savedSecret = process.env.METAMAP_WEBHOOK_SECRET;
    delete process.env.METAMAP_WEBHOOK_SECRET;

    const { parseWebhook: parse } = require('./metamap-client');
    const body = makeVerificationCompletedBody();
    const result = parse(body, 'some-sig');

    expect(result.valid).toBe(false);

    // Restore
    if (savedSecret) process.env.METAMAP_WEBHOOK_SECRET = savedSecret;
    delete require.cache[require.resolve('./metamap-client')];
  });
});
