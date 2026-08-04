'use strict';

// Applicant PII must not travel from an upstream error body into our HTTP
// response body.
//
// scCall() builds its Error message out of the RAW upstream response body
// (`new Error('SC API ' + path + ': ' + JSON.stringify(d))`) and the four
// /internal/* routes answered with `res.status(500).json({ error: err.message
// })`. SoftCrédito's validation errors echo the fields we sent them, so that
// put the employee's full name and destination CLABE (/spei/transfer), the
// employer RFC and contact email (/employers/register) and the employee CLABE
// (/deductions/register) verbatim into a response body that callers persist
// and alert on:
//
//   services/payment-server/index.js       -> loans.disbursementError,
//                                             incident_log.error,
//                                             alertDisbursementFailed() (Slack/PagerDuty)
//   functions/src/index.ts                 -> loans.disbursementError,
//                                             disbursement_queue.error,
//                                             audit log meta.error
//
// The tests below are the reason the /internal/* error bodies are now a
// machine-readable code rather than free text. Each route gets:
//   - a LEAK test  (fails before the fix, passes after)
//   - CONTROLS     (pass both before and after: status codes and healthy-path
//                   response shapes are unchanged)

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

jest.mock('../lib/scToken', () => ({
  scTokenRaw: jest.fn().mockResolvedValue({ token: 'sc-access-token', expires_in: 900 }),
}));
jest.mock('../lib/fetchClient', () => ({
  getFetch: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const { getFetch } = require('../lib/fetchClient');

const SECRET = process.env.INTERNAL_SECRET;
const fetchMock = jest.fn();
getFetch.mockResolvedValue(fetchMock);

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

// ── The PII an upstream error body can echo back at us ──────────────────────
// CURP is the Mexican national ID; RFC the tax ID; CLABE the 18-digit bank
// account number. FULL_NAME is the one that matters most and the one no
// pattern matcher can catch, which is why the rule is "no upstream free text
// in a response body" rather than "scrub the upstream free text".
const CURP      = 'GAHA850315MDFRRN08';
const FULL_NAME = 'Ana Gabriela García Hernández';
const CLABE     = '012180012345678901';
const RFC       = 'TVI010101AB1';
const EMAIL     = 'ops@tacosvida.mx';

/**
 * Assert that no fragment of applicant PII survives anywhere in a response.
 * Serialises the whole body rather than checking a single field, so a fix that
 * merely moves the leak from `error` to some new `detail` field still fails.
 */
function expectNoPii(res, values) {
  const serialised = JSON.stringify(res.body);
  for (const v of values) {
    expect(serialised).not.toContain(v);
  }
  // Also check the raw text in case a route ever answers non-JSON.
  for (const v of values) {
    expect(res.text || '').not.toContain(v);
  }
}

// ── /internal/disburse ──────────────────────────────────────────────────────
describe('POST /internal/disburse — upstream error body must not leak PII', () => {
  const VALID_BODY = {
    loanId: 'loan_1',
    clabe: CLABE,
    amount: 5000,
    concept: 'Préstamo VIDA',
    employeeName: FULL_NAME,
    employeeId: 'emp_1',
  };

  function seed(loanId) {
    admin.__seed('loans', loanId, { status: 'approved', amount: 5000, employeeId: 'emp_1' });
    admin.__seed('disbursement_queue', loanId, { status: 'pending', loanId });
  }

  function post(body) {
    return request(app).post('/internal/disburse').set('x-internal-secret', SECRET).send(body);
  }

  // A SoftCrédito validation rejection that quotes back what we sent it. The
  // free-text `message` is the realistic shape: vendors put the offending
  // value in the human-readable string.
  const UPSTREAM_REJECTION = {
    error_code: 'INVALID_CLABE',
    message: `destinationClabe ${CLABE} is not valid for recipientName ${FULL_NAME}`,
    recipientName: FULL_NAME,
    destinationClabe: CLABE,
  };

  test('LEAK: the employee name and CLABE from the upstream body are absent from the response', async () => {
    seed('loan_leak_1');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, UPSTREAM_REJECTION));

    const res = await post({ ...VALID_BODY, loanId: 'loan_leak_1' });

    expectNoPii(res, [FULL_NAME, CLABE]);
  });

  test('LEAK: an upstream body carrying a CURP does not put it in the response', async () => {
    // We do not send a CURP to /spei/transfer, but the upstream body shape is
    // the vendor's to choose, not ours to assume. Nothing about the response
    // should depend on which PII fields happen to come back.
    seed('loan_leak_2');
    fetchMock.mockResolvedValueOnce(jsonResponse(422, {
      error_code: 'KYC_MISMATCH',
      message: `CURP ${CURP} does not match ${FULL_NAME}`,
      curp: CURP,
    }));

    const res = await post({ ...VALID_BODY, loanId: 'loan_leak_2' });

    expectNoPii(res, [CURP, FULL_NAME]);
  });

  test('CONTROL: an upstream rejection is still a 500 and still writes nothing', async () => {
    seed('loan_ctl_1');
    fetchMock.mockResolvedValueOnce(jsonResponse(400, UPSTREAM_REJECTION));

    const res = await post({ ...VALID_BODY, loanId: 'loan_ctl_1' });

    expect(res.status).toBe(500);
    expect(admin.__get('loans', 'loan_ctl_1').status).toBe('approved');
    expect(admin.__all('spei_log')).toHaveLength(0);
  });

  test('CONTROL: the healthy path is unchanged', async () => {
    seed('loan_ok_1');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { trackingCode: 'TRK-001', transferId: 'tr_abc' }));

    const res = await post({ ...VALID_BODY, loanId: 'loan_ok_1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ref: 'TRK-001', transferId: 'tr_abc' });
    expect(admin.__get('loans', 'loan_ok_1').status).toBe('active');
  });

  test('CONTROL: the missing-fields 400 is unchanged and never calls upstream', async () => {
    const res = await post({ ...VALID_BODY, clabe: undefined });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing fields' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── /internal/register-employer ─────────────────────────────────────────────
describe('POST /internal/register-employer — upstream error body must not leak PII', () => {
  const VALID_BODY = {
    employerUid: 'employer_1',
    companyName: 'Tacos VIDA SA de CV',
    rfc: RFC,
    clabe: '012180012345678902',
    contactEmail: EMAIL,
  };

  function post(body) {
    return request(app).post('/internal/register-employer').set('x-internal-secret', SECRET).send(body);
  }

  const UPSTREAM_REJECTION = {
    error_code: 'RFC_ALREADY_REGISTERED',
    message: `rfc ${RFC} already registered against contactEmail ${EMAIL}`,
    rfc: RFC,
    contactEmail: EMAIL,
  };

  test('LEAK: the RFC and contact email from the upstream body are absent from the response', async () => {
    admin.__seed('employers', 'employer_1', {});
    fetchMock.mockResolvedValueOnce(jsonResponse(409, UPSTREAM_REJECTION));

    const res = await post(VALID_BODY);

    expectNoPii(res, [RFC, EMAIL]);
  });

  test('CONTROL: an upstream rejection is still a 500 and writes nothing', async () => {
    admin.__seed('employers', 'employer_1', {});
    fetchMock.mockResolvedValueOnce(jsonResponse(409, UPSTREAM_REJECTION));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(500);
    expect(admin.__get('employers', 'employer_1').softcreditoEmployerId).toBeUndefined();
    expect(admin.__all('softcredito_employers')).toHaveLength(0);
  });

  test('CONTROL: the healthy path is unchanged', async () => {
    admin.__seed('employers', 'employer_1', { companyName: VALID_BODY.companyName });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { employerId: 'sc_emp_1' }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, employerId: 'sc_emp_1' });
  });
});

// ── /internal/register-deduction ────────────────────────────────────────────
describe('POST /internal/register-deduction — upstream error body must not leak PII', () => {
  const EMPLOYEE_CLABE = '012180099999999901';
  const VALID_BODY = {
    loanId: 'loan_1',
    employeeId: 'emp_1',
    employerId: 'employer_1',
    amount: 1200,
    dueDate: '2026-09-01',
  };

  function seed() {
    admin.__seed('employers', 'employer_1', { softcreditoEmployerId: 'sc_emp_1' });
    admin.__seed('employees', 'emp_1', { bankClabe: EMPLOYEE_CLABE });
    admin.__seed('loans', 'loan_1', { status: 'active' });
  }

  function post(body) {
    return request(app).post('/internal/register-deduction').set('x-internal-secret', SECRET).send(body);
  }

  const UPSTREAM_REJECTION = {
    error_code: 'INVALID_CLABE',
    message: `employeeClabe ${EMPLOYEE_CLABE} rejected for ${FULL_NAME}`,
    employeeClabe: EMPLOYEE_CLABE,
    employeeName: FULL_NAME,
  };

  test('LEAK: the employee CLABE and name from the upstream body are absent from the response', async () => {
    seed();
    fetchMock.mockResolvedValueOnce(jsonResponse(422, UPSTREAM_REJECTION));

    const res = await post(VALID_BODY);

    expectNoPii(res, [EMPLOYEE_CLABE, FULL_NAME]);
  });

  test('CONTROL: an upstream rejection is still a 500 and the loan is not stamped', async () => {
    seed();
    fetchMock.mockResolvedValueOnce(jsonResponse(422, UPSTREAM_REJECTION));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(500);
    expect(admin.__get('loans', 'loan_1').softcreditoDeductionId).toBeUndefined();
  });

  test('CONTROL: the healthy path is unchanged', async () => {
    seed();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deductionId: 'ded_1' }));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deductionId: 'ded_1' });
  });

  test('CONTROL: a local precondition failure keeps its own message (not an upstream body)', async () => {
    // "Employer not registered with SoftCrédito" is our own string, thrown
    // before any upstream call. It carries no upstream body and must keep
    // working as a diagnosable message.
    admin.__seed('employers', 'employer_1', {});

    const res = await post(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Employer not registered with SoftCrédito');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── /internal/sync-repayments ───────────────────────────────────────────────
describe('POST /internal/sync-repayments — upstream error body must not leak PII', () => {
  function post() {
    return request(app).post('/internal/sync-repayments').set('x-internal-secret', SECRET).send({});
  }

  test('LEAK: PII in the completed-deductions error body is absent from the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {
      error_code: 'BATCH_FAILED',
      message: `deduction for ${FULL_NAME} (CURP ${CURP}, CLABE ${CLABE}) could not be settled`,
    }));

    const res = await post();

    expectNoPii(res, [FULL_NAME, CURP, CLABE]);
  });

  test('CONTROL: an upstream rejection is still a 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'upstream down' }));

    const res = await post();

    expect(res.status).toBe(500);
  });

  test('CONTROL: the healthy path is unchanged', async () => {
    admin.__seed('loans', 'loan_1', { softcreditoDeductionId: 'ded_1', status: 'active', employeeId: 'emp_1' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { deductions: [{ deductionId: 'ded_1', amount: 800, reference: 'REF1' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, synced: 1 });
  });
});

// ── Malformed upstream bodies ───────────────────────────────────────────────
describe('a malformed (non-JSON) upstream body must not leak its content', () => {
  test('LEAK: the JSON parse error message, which quotes the body, does not reach the response', async () => {
    // Node's JSON.parse error message embeds a slice of the offending input
    // (`Unexpected token 'A', "Ana Gabri"... is not valid JSON`), so an
    // upstream answering 200 with a non-JSON body containing a name leaks it
    // through exactly the same `err.message` path as a structured rejection.
    admin.__seed('loans', 'loan_bad', { status: 'approved', amount: 5000, employeeId: 'emp_1' });
    admin.__seed('disbursement_queue', 'loan_bad', { status: 'pending', loanId: 'loan_bad' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError(`Unexpected token 'A', "${FULL_NAME}" is not valid JSON`); },
    });

    const res = await request(app)
      .post('/internal/disburse')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_bad', clabe: CLABE, amount: 5000, concept: 'x', employeeName: FULL_NAME, employeeId: 'emp_1' });

    expect(res.status).toBe(500); // CONTROL: status unchanged
    expectNoPii(res, [FULL_NAME]);
  });
});

// ── Already-safe routes: these are CONTROLS, not leak tests ─────────────────
describe('CONTROL: /bureau/query and /curp/validate already withhold the upstream body', () => {
  // These two routes were fixed in #527 (fail-closed 502 with a classified
  // reason). They are asserted here so that the shared error helper introduced
  // for the /internal/* routes cannot regress them.
  test('/bureau/query answers 502 with a reason and no CURP or name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error_code: 'BUREAU_VALIDATION',
      message: `curp ${CURP} / fullName ${FULL_NAME} rejected`,
    }));

    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', SECRET)
      .send({ curp: CURP, fullName: FULL_NAME, dateOfBirth: '1985-03-15' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('bureau_unavailable');
    expectNoPii(res, [CURP, FULL_NAME]);
  });

  test('/curp/validate answers 502 with a reason and no CURP or name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error_code: 'RENAPO_MISMATCH',
      message: `curp ${CURP} does not match expectedName ${FULL_NAME}`,
    }));

    const res = await request(app)
      .post('/curp/validate')
      .set('x-internal-secret', SECRET)
      .send({ curp: CURP, expectedName: FULL_NAME });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('curp_validation_unavailable');
    expectNoPii(res, [CURP, FULL_NAME]);
  });
});
