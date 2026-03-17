/**
 * Mifiel e-signing — NOM-151 compliant electronic signatures for pagares.
 *
 * Flow: generate pagare PDF -> sendPagareForSigning -> borrower signs via
 * e.firma or SMS OTP -> Mifiel webhook fires -> loan disbursement unlocks.
 *
 * SDK: mifiel@0.0.1
 * Sandbox: https://app-sandbox.mifiel.com
 * Production: complete KYB at mifiel.com first (SOFOM RFC required).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mifiel = require('mifiel').default;
const Document = Mifiel.Models.Document;

function init(): void {
  Mifiel.Config.setTokens(
    process.env.MIFIEL_APP_ID,
    process.env.MIFIEL_APP_SECRET || process.env.MIFIEL_ACCESS_TOKEN,
  );
  Mifiel.Config.url =
    process.env.MIFIEL_ENV === 'production'
      ? 'https://www.mifiel.com/api/v1'
      : 'https://app-sandbox.mifiel.com/api/v1';
}

export interface SendPagareOptions {
  pdfPath: string;
  borrowerName: string;
  borrowerEmail: string;
  borrowerRfc: string;
  loanId: string;
}

export interface PagareResult {
  documentId: string;
  signingUrl: string;
  expiresAt: string;
}

export async function sendPagareForSigning(opts: SendPagareOptions): Promise<PagareResult> {
  init();
  const doc = new Document({
    file: opts.pdfPath,
    signatories: [
      { name: opts.borrowerName, email: opts.borrowerEmail, tax_id: opts.borrowerRfc },
    ],
    callback_url: `${process.env.API_BASE_URL}/webhooks/mifiel/signed`,
    external_id: opts.loanId,
  });
  const result = await doc.save();
  return {
    documentId: result.id,
    signingUrl: result.file,
    expiresAt: result.expires_at,
  };
}

export interface DocumentStatus {
  signed: boolean;
  signedPdfUrl: string | null;
  nom151Cert: unknown | null;
  raw: unknown;
}

export async function getDocumentStatus(documentId: string): Promise<DocumentStatus> {
  init();
  const doc = await Document.find(documentId);
  return {
    signed: !!doc.signed,
    signedPdfUrl: doc.file_signed || null,
    nom151Cert: doc.certificate_detail || null,
    raw: doc,
  };
}
