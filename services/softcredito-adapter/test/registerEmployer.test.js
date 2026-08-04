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

function postRegisterEmployer(body) {
  return request(app).post('/internal/register-employer').set('x-internal-secret', SECRET).send(body);
}

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
});

const VALID_BODY = {
  employerUid: 'employer_1',
  companyName: 'Tacos VIDA SA de CV',
  rfc: 'TVI010101AB1',
  clabe: '012180012345678902',
  contactEmail: 'ops@tacosvida.mx',
};

describe('POST /internal/register-employer — happy path', () => {
  test('registers with SoftCrédito and writes both employers and softcredito_employers', async () => {
    admin.__seed('employers', 'employer_1', { companyName: VALID_BODY.companyName, verified: true });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { employerId: 'sc_emp_1' }));

    const res = await postRegisterEmployer(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, employerId: 'sc_emp_1' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sc.test/api/employers/register');
    expect(JSON.parse(opts.body)).toMatchObject({
      name: VALID_BODY.companyName,
      rfc: VALID_BODY.rfc,
      payrollClabe: VALID_BODY.clabe,
      contactEmail: VALID_BODY.contactEmail,
      metadata: { firebaseUid: 'employer_1' },
    });

    const employer = admin.__get('employers', 'employer_1');
    expect(employer.softcreditoEmployerId).toBe('sc_emp_1');

    const scEmployer = admin.__get('softcredito_employers', 'employer_1');
    expect(scEmployer).toMatchObject({
      employerId: 'sc_emp_1',
      companyName: VALID_BODY.companyName,
      rfc: VALID_BODY.rfc,
      clabe: VALID_BODY.clabe,
      status: 'active',
    });
  });
});

describe('POST /internal/register-employer — malformed / missing-field payloads', () => {
  // DEFECT: this route has NO field validation at all (contrast with
  // /internal/disburse's explicit `if (!loanId || !clabe || !amount) return
  // 400`). A request missing employerUid still calls SoftCrédito's
  // employer-registration endpoint -- registering a real employer with them
  // -- and only fails afterwards, when the local Firestore write targets an
  // auto-generated document ID that was never created by `.update()`. See
  // services/softcredito-adapter/index.js:158-182.
  test('a missing employerUid still calls SoftCrédito, then 500s on the local write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { employerId: 'sc_emp_ghost' }));

    const res = await postRegisterEmployer({ ...VALID_BODY, employerUid: undefined });

    // The outbound call to SoftCrédito already happened -- a real employer
    // registration was dispatched for a request with no employerUid.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/No document to update/);
  });

  test('an unknown employerUid: SoftCrédito is still called before the local 500', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { employerId: 'sc_emp_2' }));

    const res = await postRegisterEmployer({ ...VALID_BODY, employerUid: 'does-not-exist' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/No document to update/);
    // No trace of the SoftCrédito registration is stored locally.
    expect(admin.__all('softcredito_employers')).toHaveLength(0);
  });
});

describe('POST /internal/register-employer — upstream failure', () => {
  test('SoftCrédito rejecting the registration is a 500 and writes nothing', async () => {
    admin.__seed('employers', 'employer_1', {});
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error_code: 'RFC_ALREADY_REGISTERED' }));

    const res = await postRegisterEmployer(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/RFC_ALREADY_REGISTERED/);
    expect(admin.__get('employers', 'employer_1').softcreditoEmployerId).toBeUndefined();
    expect(admin.__all('softcredito_employers')).toHaveLength(0);
  });
});
