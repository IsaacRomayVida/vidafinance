'use strict';

// The contract that reaches MetaMap for signature must be base64, and for a
// while it was not.
//
// puppeteer >= 23 resolves page.pdf() to a plain Uint8Array rather than a
// Buffer. Uint8Array does not carry Buffer's encoding-aware toString, so
// `pdf.toString('base64')` in the signing path silently produced
// "37,80,68,70,..." — the decimal bytes, comma-separated. The HTTP call to
// MetaMap still succeeded, the loan was still marked awaiting_signature, and
// the document the borrower would sign was corrupt.
//
// Nothing caught it because __mocks__/puppeteer.js returned a Buffer, which is
// more convenient than what puppeteer actually returns. The mock now returns a
// Uint8Array, and this test asserts the property that actually matters: what
// the signing client receives decodes back to the exact PDF bytes.

const { setBaseEnv } = require('./testEnv');
setBaseEnv();

const request = require('supertest');
const { app } = require('../index');
const admin = require('firebase-admin');
const puppeteerMock = require('puppeteer');

const SECRET = process.env.INTERNAL_SECRET;

function seedLoan(loanId, overrides = {}) {
  admin.__seed('loans', loanId, {
    employeeName: 'Ana Torres',
    employerName: 'Acme SA de CV',
    employeeEmail: 'ana@example.com',
    amount: 1000,
    fee: 300,
    total: 1300,
    feeRate: 0.3,
    term: 30,
    dueDate: { toDate: () => new Date('2026-09-01T00:00:00Z') },
    ...overrides,
  });
}

beforeEach(() => {
  admin.__reset();
});

describe('the PDF handed to MetaMap is really base64', () => {
  const signing = require('../src/metamap-signing-client');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('pdfBase64 decodes back to the rendered PDF bytes', async () => {
    let captured = null;
    jest.spyOn(signing, 'isEnabled').mockReturnValue(true);
    jest.spyOn(signing, 'createSignedDocument').mockImplementation(async (args) => {
      captured = args.pdfBase64;
      return { documentId: 'doc_b64', status: 'pending' };
    });
    seedLoan('loan_b64');

    const res = await request(app)
      .post('/contracts/generate')
      .set('x-internal-secret', SECRET)
      .send({ loanId: 'loan_b64', employeeId: 'emp_b64', metamapVerificationId: 'verif_b64' });

    expect(res.status).toBe(200);
    expect(typeof captured).toBe('string');

    // The exact failure mode: decimal bytes joined by commas.
    expect(captured).not.toMatch(/^\d+(,\d+)+$/);
    expect(captured).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    // The property worth asserting — it round-trips to the real bytes.
    const decoded = Buffer.from(captured, 'base64');
    expect(Buffer.from(puppeteerMock.__PDF_BUFFER).equals(decoded)).toBe(true);
    expect(decoded.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
