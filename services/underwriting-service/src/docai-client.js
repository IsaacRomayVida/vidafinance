"use strict";
/**
 * docai-client.js
 * Google Document AI — payroll slip OCR (Form Parser).
 *
 * Reuses FIREBASE_SERVICE_ACCOUNT credentials (same SA used by all services).
 * The SA needs roles/documentai.apiUser on the GCP project.
 *
 * Processor: vida-payroll-parser (8d46c79a75eb5406), Form Parser, us region.
 * Docs: https://cloud.google.com/document-ai/docs
 */
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;

let _client = null;

function getDocAIClient() {
  if (_client) return _client;
  const creds = JSON.parse(
    process.env.GOOGLE_DOCAI_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT
  );
  _client = new DocumentProcessorServiceClient({ credentials: creds });
  return _client;
}

/**
 * Parse a payroll slip (PDF or image) using Google Document AI.
 * @param {Buffer} fileBuffer - PDF or image buffer
 * @param {string} mimeType - "application/pdf" | "image/jpeg" | "image/png"
 * @returns {{ raw, salarioBruto, salarioNeto, imssNum, rfcEmpleador, periodo, deductions }}
 */
async function parsePayrollSlip(fileBuffer, mimeType = "application/pdf") {
  const client = getDocAIClient();
  const name = [
    `projects/${process.env.GOOGLE_DOCAI_PROJECT_ID}`,
    `locations/${process.env.GOOGLE_DOCAI_LOCATION}`,
    `processors/${process.env.GOOGLE_DOCAI_PROCESSOR_ID}`,
  ].join("/");

  const [result] = await client.processDocument({
    name,
    rawDocument: { content: fileBuffer.toString("base64"), mimeType },
  });

  const fields = {};
  for (const page of result.document.pages || []) {
    for (const field of page.formFields || []) {
      const key   = field.fieldName?.textAnchor?.content?.trim().toLowerCase() || "";
      const value = field.fieldValue?.textAnchor?.content?.trim() || "";
      if (key) fields[key] = value;
    }
  }

  return {
    raw:           fields,
    salarioBruto:  fields["salario bruto"] || fields["sueldo"] || fields["percepciones totales"] || null,
    salarioNeto:   fields["neto a pagar"] || fields["neto pagado"] || null,
    imssNum:       fields["nss"] || fields["número de seguro social"] || null,
    rfcEmpleador:  fields["rfc del patrón"] || fields["rfc empresa"] || null,
    periodo:       fields["periodo"] || fields["fecha de pago"] || null,
    deductions:    extractDeductions(fields),
  };
}

function extractDeductions(fields) {
  const deductions = {};
  for (const k of Object.keys(fields)) {
    if (k.includes("infonavit")) deductions.infonavit = parseFloat(fields[k].replace(/,/g, "")) || 0;
    if (k.includes("fonacot"))   deductions.fonacot   = parseFloat(fields[k].replace(/,/g, "")) || 0;
    if (k.includes("imss"))      deductions.imss      = parseFloat(fields[k].replace(/,/g, "")) || 0;
    if (k.includes("isr"))       deductions.isr       = parseFloat(fields[k].replace(/,/g, "")) || 0;
  }
  return deductions;
}

module.exports = { parsePayrollSlip };
