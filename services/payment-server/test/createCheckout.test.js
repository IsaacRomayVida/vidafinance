'use strict';

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const fetchMock = require('node-fetch');

const SECRET = process.env.INTERNAL_SECRET;

beforeEach(() => {
  admin.__reset();
  fetchMock.mockReset();
  delete process.env.CONEKTA_API_KEY;
});

function postCheckout(body) {
  return request(app).post('/create-checkout').set('x-internal-secret', SECRET).send(body);
}

test('400s when loanId, amount, or employeeId is missing', async () => {
  const res = await postCheckout({ loanId: 'loan_1', amount: 100 });
  expect(res.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('500s with no Conekta API key configured', async () => {
  const res = await postCheckout({ loanId: 'loan_1', amount: 100, employeeId: 'emp_1' });
  expect(res.status).toBe(500);
  expect(res.body.error).toMatch(/Conekta API key not configured/);
});

describe('with CONEKTA_API_KEY set', () => {
  beforeEach(() => {
    process.env.CONEKTA_API_KEY = 'sk_test_123';
  });

  test('happy path: creates the order and returns paymentUrl/orderId', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'ord_1', checkout: { url: 'https://pay.conekta.com/ord_1' } }),
    });

    const res = await postCheckout({ loanId: 'loan_1', amount: 500, employeeId: 'emp_1', employeeName: 'Ana' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paymentUrl: 'https://pay.conekta.com/ord_1', orderId: 'ord_1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.conekta.io/orders');
    expect(opts.headers.Authorization).toBe('Bearer sk_test_123');
    const payload = JSON.parse(opts.body);
    expect(payload.metadata).toEqual({ loanId: 'loan_1', employeeId: 'emp_1' });
    expect(payload.line_items[0].unit_price).toBe(50000); // amount * 100
  });

  test('502s and logs an incident when Conekta rejects the order', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'invalid card token' });

    const res = await postCheckout({ loanId: 'loan_2', amount: 500, employeeId: 'emp_2' });

    expect(res.status).toBe(502);
    expect(res.body.details).toBe('invalid card token');
    const incidents = admin.__all('incident_log');
    expect(incidents[0].data).toMatchObject({ source: 'create-checkout', loanId: 'loan_2', error: 'invalid card token' });
  });

  test('502s when Conekta responds 200 but omits the checkout URL or order id', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ checkout: {} }) });

    const res = await postCheckout({ loanId: 'loan_3', amount: 500, employeeId: 'emp_3' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Invalid Conekta response/);
  });

  test('500s and logs an incident when the Conekta call itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await postCheckout({ loanId: 'loan_4', amount: 500, employeeId: 'emp_4' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('ECONNRESET');
    expect(admin.__all('incident_log')[0].data.error).toBe('ECONNRESET');
  });
});
