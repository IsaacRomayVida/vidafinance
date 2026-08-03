'use strict';

// Minimal puppeteer stand-in -- never launches a real browser/Chromium.
// index.js only calls launch(), newPage(), setContent(), pdf(), close().

const PDF_BUFFER = Buffer.from('%PDF-1.4 mock pdf content');

function makePage() {
  return {
    async setContent() {},
    async pdf() {
      return PDF_BUFFER;
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
module.exports.__PDF_BUFFER = PDF_BUFFER;
