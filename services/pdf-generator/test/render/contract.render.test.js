'use strict';

// REAL rendering test -- launches actual Chromium through puppeteer and
// renders the real loan-contract template. This intentionally does NOT run
// as part of the default `npm test` (see the exclusion in ../../jest.config.js
// and the separate ../../jest.render.config.js this file is matched by).
//
// Why separate: __mocks__/puppeteer.js is a manual mock for a node_modules
// package, which Jest applies automatically to every `require('puppeteer')`
// in this project without an explicit jest.mock() call. The 32 tests in
// test/contractsGenerate.test.js and test/worker.test.js rely on that mock
// staying in place -- they assert on HTTP/queue plumbing, not on Chromium
// actually being able to render anything. This file explicitly opts back
// into the real module with jest.unmock() below, and lives in its own
// directory/config so:
//   (a) it can never accidentally get picked up alongside the mocked tests
//       and silently start unmocking puppeteer for them too, and
//   (b) launching real Chromium (slow: real process spawn + page render)
//       never slows down the fast mocked suite.
//
// Run it with: npm run test:render
//
// KNOWN FINDING (2026-09-19): in this environment, index.js's renderPDF()
// configuration -- headless: true (Puppeteer's default "new" headless mode)
// plus the --disable-gpu launch arg -- makes page.setContent(html,
// { waitUntil: "networkidle0" }) hang indefinitely. Isolated by bisecting
// the exact args renderPDF() passes:
//   - dropping --disable-gpu alone: setContent/networkidle0 resolves in
//     under 1s with the same content.
//   - launching with headless: 'shell' (pre-"new" headless mode) instead:
//     also resolves in ~2s with --disable-gpu still present.
//   - page.goto('data:text/html,...', { waitUntil: 'networkidle0' }) is
//     unaffected either way -- only setContent() on an already-open page
//     hangs.
//   - reproduced against BOTH Chrome 148.0.7778.97 (puppeteer 24.43.1's
//     current pin) and Chrome 146.0.7680.76 (puppeteer 24.39.1's pin, i.e.
//     the version before the recent bump) -- so this is not something the
//     24.39.1 -> 24.43.1 bump introduced, but it is a real, currently-live
//     hazard in renderPDF()'s exact configuration that nothing previously
//     caught. See the test below: it keeps renderPDF()'s real args
//     unchanged (deliberately -- rewriting them here to whatever "works"
//     would just hide the bug) and fails fast with a clear message instead
//     of quietly waiting out Jest's full test timeout if the hang
//     reproduces.
jest.unmock('puppeteer');

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const Handlebars = require('handlebars');
const pdfParse = require('pdf-parse');

// Chromium is downloaded into a local cache the first time `npm install`
// runs puppeteer's postinstall step. In an environment where that never
// happened (offline CI image, pruned cache, etc.) puppeteer.launch() throws
// instead of silently no-oping, so detect it up front and skip with a clear
// reason rather than letting the whole suite fail or (worse) pass green
// without ever proving anything.
function detectChromium() {
  try {
    const execPath = puppeteer.executablePath();
    return { available: fs.existsSync(execPath), execPath };
  } catch (err) {
    return { available: false, execPath: null, error: err.message };
  }
}

const { available: chromiumAvailable, execPath, error: detectError } = detectChromium();

if (!chromiumAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    '[contract.render.test] SKIPPING: bundled Chromium not found' +
      (execPath ? ` at ${execPath}` : '') +
      (detectError ? ` (${detectError})` : '') +
      '. Install it with `npx puppeteer browsers install chrome` from ' +
      'services/pdf-generator, then re-run `npm run test:render`.',
  );
}

const maybeTest = chromiumAvailable ? test : test.skip;

// Mirrors CONTRACT_TPL compilation in ../../index.js exactly (same template
// file, same Handlebars.compile call) rather than requiring index.js itself,
// which would also pull in firebase-admin/ioredis/bullmq and refuse to boot
// without INTERNAL_SECRET and real Firebase credentials -- none of which
// this test needs in order to prove Chromium can render the template.
const CONTRACT_TPL = Handlebars.compile(
  fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'contract.hbs'), 'utf8'),
);

const fmt = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 });

// Fails fast with a specific, actionable message instead of letting a hang
// ride out Jest's full per-test timeout with a generic "Exceeded timeout"
// error -- see the KNOWN FINDING comment above for how this was found.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Representative Mexican payroll-loan data, shaped exactly like the fields
// index.js's route handler and worker both pass to CONTRACT_TPL (see
// app.post('/contracts/generate', ...) and the loan_contract worker branch).
const AMOUNT = 8500;
const FEE_RATE = 0.3;
const FEE = AMOUNT * FEE_RATE;
const TOTAL = AMOUNT + FEE;
const TERM_DAYS = 30;
// Same CAT formula as contractTerms() in index.js.
const CAT = ((Math.pow(1 + FEE / AMOUNT, 365 / TERM_DAYS) - 1) * 100).toFixed(0);

const loanData = {
  loanId: '7F3A9C21',
  issuedDate: '15/09/2026',
  dueDate: '15/10/2026',
  employeeName: 'María Fernanda López Ramírez',
  employerName: 'Grupo Industrial Azteca S.A. de C.V.',
  amount: fmt(AMOUNT),
  fee: fmt(FEE),
  feePct: Math.round(FEE_RATE * 100),
  termDays: TERM_DAYS,
  total: fmt(TOTAL),
  cat: CAT,
  sofomRfc: 'VFI240115AB9',
  sofomAddress: 'Paseo de la Reforma 250, Piso 12, Colonia Juárez, CDMX',
};

describe('contract template — real Chromium render', () => {
  let browser;

  afterAll(async () => {
    if (browser) await browser.close();
  });

  maybeTest(
    'renders the real loan contract to a genuine PDF containing the loan data',
    async () => {
      const html = CONTRACT_TPL(loanData);

      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      const page = await browser.newPage();
      await withTimeout(
        page.setContent(html, { waitUntil: 'networkidle0' }),
        10000,
        'page.setContent(html, { waitUntil: "networkidle0" }) did not resolve within 10s. ' +
          'This is a known hang in this environment: renderPDF()\'s exact launch args ' +
          '(headless: true + --disable-gpu) combined with waitUntil: "networkidle0" on ' +
          'setContent() (not goto()) never fires network-idle. See the KNOWN FINDING ' +
          'comment at the top of this file for the isolated repro and possible causes. ' +
          'This is not a flaky-download problem -- Chromium launched fine; the render ' +
          "itself is what's stuck. If contract generation is hanging in production, " +
          'start there.',
      );
      const raw = await page.pdf({ format: 'A4', printBackground: true });
      await page.close();

      // 0. The hazard that made this test worth writing. puppeteer >= 23
      // resolves page.pdf() to a plain Uint8Array, and Uint8Array has no
      // encoding-aware toString -- so `raw.toString('base64')` yields
      // "37,80,68,70,..." rather than base64, and the contract that went to
      // MetaMap for signature was corrupt. renderPDF() in index.js normalises
      // with Buffer.from() for exactly this reason; mirror it here, and assert
      // the raw shape so a future puppeteer that changes it back is loud
      // rather than silent.
      expect(Buffer.isBuffer(raw)).toBe(false);
      expect(raw).toBeInstanceOf(Uint8Array);
      const pdf = Buffer.from(raw);
      expect(pdf.toString('base64')).not.toMatch(/^\d+(,\d+)+$/);

      // 1. Real PDF magic bytes -- the mock returns '%PDF-1.4 mock pdf
      // content', which also starts with '%PDF-', so this alone wouldn't
      // distinguish a real render from the mock; it's the first of several
      // checks below.
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

      // 2. Substantially larger than a trivial/mock buffer. The mock is 26
      // bytes; a real single-page A4 PDF with this template's inline CSS
      // renders to tens of KB.
      expect(pdf.length).toBeGreaterThan(5000);

      // 3. Extract real text and page count via pdf-parse (wraps pdf.js) --
      // this is the part a hardcoded mock buffer could never pass.
      const parsed = await pdfParse(pdf);
      expect(parsed.numpages).toBeGreaterThan(0);

      const text = parsed.text;

      // 4. The loan data actually made it into the rendered output --
      // the single most valuable assertion here, since it proves the
      // Handlebars -> HTML -> Chromium -> PDF pipeline end to end, not just
      // "some bytes came back".
      expect(text).toContain('7F3A9C21'); // loanId (folio)
      expect(text).toContain('María Fernanda López Ramírez'); // employeeName
      expect(text).toContain('Grupo Industrial Azteca S.A. de C.V.'); // employerName
      expect(text).toContain(fmt(AMOUNT)); // amount
      expect(text).toContain(fmt(FEE)); // fee
      expect(text).toContain(fmt(TOTAL)); // total to reembolsar
      expect(text).toContain('30'); // feePct / termDays
      expect(text).toContain(CAT); // disclosed CAT
      expect(text).toContain('VFI240115AB9'); // sofomRfc
      expect(text).toContain('CONDUSEF'); // regulated disclosure boilerplate
    },
  );
});
