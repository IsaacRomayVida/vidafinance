"use strict";
/**
 * mifiel-client.js
 * Mifiel e-signing — NOM-151 compliant electronic signatures for pagarés.
 *
 * Flow: generate pagaré PDF → sendPagareForSigning → borrower signs via
 * e.firma or SMS OTP → Mifiel webhook fires → loan disbursement unlocks.
 *
 * SDK: mifiel@0.0.1 — instance-based API:
 *   new Document({ file, signatories, ... }).save()
 *   Document.find(id)
 *
 * Sandbox: https://app-sandbox.mifiel.com
 * Production: complete KYB at mifiel.com first (SOFOM RFC required).
 * Docs: https://docs.mifiel.com
 */
const Mifiel = require("mifiel").default;
const Document = Mifiel.Models.Document;

function init() {
  Mifiel.Config.setTokens(
    process.env.MIFIEL_APP_ID,
    process.env.MIFIEL_APP_SECRET || process.env.MIFIEL_ACCESS_TOKEN
  );
  Mifiel.Config.url = process.env.MIFIEL_ENV === "production"
    ? "https://www.mifiel.com/api/v1"
    : "https://app-sandbox.mifiel.com/api/v1";
}

/**
 * Upload a pagaré PDF and send it for e-signing.
 * @param {object} opts
 * @param {string} opts.pdfPath - absolute path to the generated pagaré PDF
 * @param {string} opts.borrowerName
 * @param {string} opts.borrowerEmail
 * @param {string} opts.borrowerRfc
 * @param {string} opts.loanId - stored as external_id for webhook correlation
 * @returns {{ documentId, signingUrl, expiresAt }}
 */
async function sendPagareForSigning({ pdfPath, borrowerName, borrowerEmail, borrowerRfc, loanId }) {
  init();
  const doc = new Document({
    file:         pdfPath,
    signatories:  [{ name: borrowerName, email: borrowerEmail, tax_id: borrowerRfc }],
    callback_url: `${process.env.API_BASE_URL}/webhooks/mifiel/signed`,
    external_id:  loanId,
  });
  const result = await doc.save();
  return {
    documentId: result.id,
    signingUrl: result.file,
    expiresAt:  result.expires_at,
  };
}

/**
 * Check signing status of a document.
 * @param {string} documentId
 * @returns {{ signed, signedPdfUrl, nom151Cert }}
 */
async function getDocumentStatus(documentId) {
  init();
  const doc = await Document.find(documentId);
  return {
    signed:       !!doc.signed,
    signedPdfUrl: doc.file_signed || null,
    nom151Cert:   doc.certificate_detail || null,
    raw:          doc,
  };
}

module.exports = { sendPagareForSigning, getDocumentStatus };
