'use strict';

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

function postRegisterDeduction(body) {
  return request(app).post('/internal/register-deduction').set('x-internal-secret', SECRET).send(body);
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

const VALID_BODY = {
  loanId: 'loan_1',
  employeeId: 'emp_1',
  employerId: 'employer_1',
  amount: 1200,
  dueDate: '2026-09-01',
};

function seedEmployerAndEmployee() {
  admin.__seed('employers', 'employer_1', { softcreditoEmployerId: 'sc_emp_1' });
  admin.__seed('employees', 'emp_1', { bankClabe: '012180099999999901' });
  admin.__seed('loans', 'loan_1', { status: 'active' });
}

describe('POST /internal/register-deduction — happy path', () => {
  test('registers the payroll deduction and stamps the loan with the deduction id', async () => {
    seedEmployerAndEmployee();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deductionId: 'ded_1' }));

    const res = await postRegisterDeduction(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deductionId: 'ded_1' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sc.test/api/deductions/register');
    expect(JSON.parse(opts.body)).toMatchObject({
      softcreditoEmployerId: 'sc_emp_1',
      employeeClabe: '012180099999999901',
      amount: 1200,
      deductionDate: '2026-09-01',
      reference: 'LOAN_1',
      metadata: { loanId: 'loan_1', employeeId: 'emp_1' },
    });

    expect(admin.__get('loans', 'loan_1').softcreditoDeductionId).toBe('ded_1');
  });
});

describe('POST /internal/register-deduction — malformed / missing-field payloads', () => {
  // DEFECT: no field validation on this route either. An unknown/missing
  // employerId reads `.data()` on a non-existent doc (undefined) and then
  // dereferences `.softcreditoEmployerId` on it, which throws a raw
  // TypeError -- surfaced to the caller as a 500 with a Node internals
  // message ("Cannot read properties of undefined"), not a clean 404
  // "Employer not found". See services/softcredito-adapter/index.js:185-189.
  test('an unknown employerId 500s with a raw TypeError, and never calls SoftCrédito', async () => {
    const res = await postRegisterDeduction({ ...VALID_BODY, employerId: 'does-not-exist' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Cannot read propert(y|ies) of undefined/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // DEFECT: same shape one field over -- an employer that HAS not been
  // registered with SoftCrédito (softcreditoEmployerId falsy) is correctly
  // rejected with a message, but a missing employeeId still gets past that
  // check and throws on `employee.bankClabe`, again a raw TypeError instead
  // of a clean 4xx.
  test('an unregistered employer (no softcreditoEmployerId) is rejected with a clear message', async () => {
    admin.__seed('employers', 'employer_1', {});
    const res = await postRegisterDeduction(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Employer not registered with SoftCrédito');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an unknown employeeId 500s with a raw TypeError before calling SoftCrédito', async () => {
    admin.__seed('employers', 'employer_1', { softcreditoEmployerId: 'sc_emp_1' });

    const res = await postRegisterDeduction({ ...VALID_BODY, employeeId: 'does-not-exist' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Cannot read propert(y|ies) of undefined/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /internal/register-deduction — upstream failure', () => {
  test('SoftCrédito rejecting the deduction is a 500 and the loan is not stamped', async () => {
    seedEmployerAndEmployee();
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { error_code: 'INVALID_CLABE' }));

    const res = await postRegisterDeduction(VALID_BODY);

    expect(res.status).toBe(500);
    // The vendor's machine code survives; the body it came in -- which echoes
    // the employee CLABE we sent -- does not. See test/upstreamPiiLeak.test.js.
    expect(res.body).toEqual({
      error: 'upstream_error',
      reason: 'upstream_error_code',
      code: 'INVALID_CLABE',
      upstreamStatus: 422,
    });
    expect(admin.__get('loans', 'loan_1').softcreditoDeductionId).toBeUndefined();
  });
});

describe('POST /internal/register-deduction — replay', () => {
  // Unlike /internal/disburse this doesn't move money directly, but it still
  // has no dedup: replaying the same request registers a SECOND deduction
  // schedule with SoftCrédito for the same loan, and the loan doc just ends
  // up stamped with whichever deductionId arrived last.
  test('replaying the identical request registers a second deduction with SoftCrédito', async () => {
    seedEmployerAndEmployee();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { deductionId: 'ded_first' }))
      .mockResolvedValueOnce(jsonResponse(200, { deductionId: 'ded_second' }));

    await postRegisterDeduction(VALID_BODY);
    const second = await postRegisterDeduction(VALID_BODY);

    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(admin.__get('loans', 'loan_1').softcreditoDeductionId).toBe('ded_second');
  });
});
