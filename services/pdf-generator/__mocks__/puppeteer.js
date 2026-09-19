'use strict';

// Minimal puppeteer stand-in -- never launches a real browser/Chromium.
// index.js only calls launch(), newPage(), setContent(), pdf(), close().

// Real puppeteer (>= 23) resolves page.pdf() to a plain Uint8Array, NOT a
// Buffer. This mock used to return a Buffer, and that one difference hid a
// live defect from 32 passing tests: Buffer.toString('base64') encodes, while
// Uint8Array.toString('base64') ignores its argument and yields
// "37,80,68,70,..." — so the contract sent to MetaMap for signature was
// corrupt. A mock that is more convenient than the real thing tests the mock.
// Return what puppeteer actually returns.
const PDF_BYTES = Uint8Array.from(Buffer.from('%PDF-1.4 mock pdf content'));

function makePage() {
  return {
    async setContent() {},
    async pdf() {
      return PDF_BYTES;
    },
    async close() {},
  };
}

const puppeteer = {
  async launch() {
    return {
      connected: true,
      async newPage() {
        return makePage();
      },
      async close() {
        this.connected = false;
      },
    };
  },
};

module.exports = puppeteer;
module.exports.__PDF_BUFFER = PDF_BYTES;
