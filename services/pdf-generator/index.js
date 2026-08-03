const express    = require("express");
const helmet     = require("helmet");
const puppeteer  = require("puppeteer");
const admin      = require("firebase-admin");
const IORedis    = require("ioredis");
const { Queue, Worker } = require("bullmq");
const Handlebars = require("handlebars");
const fs         = require("fs");
const path       = require("path");
const { alert5xx, alertQueueDepth, alertRedisLost } = require("../shared/alerting");
const { register: metricsRegister, metricsMiddleware } = require("../shared/metrics");
const createLogger = require("../shared/logger");
require("dotenv").config();

const log = createLogger("vida-pdf-generator");

// Fail closed: requireInternal compares the request header against
// process.env.INTERNAL_SECRET. If the variable is unset both sides are
// `undefined`, the strict-inequality check is false, and every internal route
// (including POST /contracts/generate) becomes publicly callable with no header
// at all. Refuse to boot rather than serve contract generation unauthenticated.
// Same pattern as vida-registry-service.
if (!process.env.INTERNAL_SECRET) {
  throw new Error("INTERNAL_SECRET is required to start vida-pdf-generator");
}

const pkg = require("./package.json");
const START_TIME = Date.now();

const svcAcct = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
const db = admin.firestore();
const storage = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith("rediss://")
    ? { rejectUnauthorized: false }
    : undefined,
});

const SERVICE_NAME = "vida-pdf-generator";
redis.on("error", (err) => {
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.message?.includes("ECONNRESET")) {
    alertRedisLost(SERVICE_NAME);
  }
});

const CONTRACT_TPL = Handlebars.compile(
  fs.readFileSync(path.join(__dirname, "templates", "contract.hbs"), "utf8")
);

const fmt = (n) =>
  Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2 });

/**
 * Derive the disclosed commission rate, term and CAT from the loan document.
 *
 * These MUST come from the loan itself, never from a constant in this file.
 * The contract template previously hardcoded "Comisión (30%)" and "30 días"
 * next to a dynamic amount, so any loan written at a different rate or term
 * would have printed a label contradicting its own figures — and the CAT is a
 * regulated disclosure, not decoration.
 *
 * `feeRate` is persisted on the loan at creation (see functions requestLoan).
 * Older loans predate that field, so fall back to deriving it from the amounts.
 */
function contractTerms(loan) {
  const termDays = Number(loan.term) || 30;
  const feeRate =
    typeof loan.feeRate === "number" ? loan.feeRate : loan.fee / loan.amount;
  const cat = (
    (Math.pow(1 + loan.fee / loan.amount, 365 / termDays) - 1) *
    100
  ).toFixed(0);
  return { feePct: Math.round(feeRate * 100), termDays, cat };
}

/**
 * Both the HTTP route and the BullMQ worker generate a contract from the same
 * loan shape. Neither should crash with a raw property-access error on a
 * missing/malformed loan -- validate once, share the result.
 */
function assertLoanReadyForContract(loan, loanId) {
  if (!loan) {
    const err = new Error(`Loan not found: ${loanId}`);
    err.code = "LOAN_NOT_FOUND";
    throw err;
  }
  if (!loan.dueDate || typeof loan.dueDate.toDate !== "function") {
    const err = new Error(`Loan ${loanId} is missing required field: dueDate`);
    err.code = "LOAN_INVALID";
    throw err;
  }
}

/* ─── Puppeteer helpers ─── */

let browser;
async function getBrowser() {
  if (!browser || !browser.connected)
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  return browser;
}

async function renderPDF(html) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  await page.close();
  return pdf;
}

async function upload(buf, filePath) {
  const file = storage.file(filePath);
  await file.save(buf, { metadata: { contentType: "application/pdf" } });
  await file.makePublic();
  return `https://storage.googleapis.com/${storage.name}/${filePath}`;
}

/* ─── BullMQ Worker ─── */

const worker = new Worker(
  "vida-pdfs",
  async (job) => {
    const { type, loanId, employeeId } = job.data;

    if (type === "loan_contract") {
      const loan = (await db.collection("loans").doc(loanId).get()).data();
      assertLoanReadyForContract(loan, loanId);
      const { feePct, termDays, cat } = contractTerms(loan);
      const html = CONTRACT_TPL({
        loanId: loanId.slice(0, 8).toUpperCase(),
        issuedDate: new Date().toLocaleDateString("es-MX"),
        dueDate: loan.dueDate.toDate().toLocaleDateString("es-MX"),
        employeeName: loan.employeeName,
        employerName: loan.employerName,
        amount: fmt(loan.amount),
        fee: fmt(loan.fee),
        feePct,
        termDays,
        total: fmt(loan.total),
        cat,
        sofomRfc: process.env.SOFOM_RFC || "VIDA240101XXX",
        sofomAddress:
          process.env.SOFOM_ADDRESS ||
          "Paseo de la Reforma 250 Piso 12, CDMX",
      });
      const pdf = await renderPDF(html);
      const url = await upload(
        pdf,
        `loans/${loanId}/contrato_${Date.now()}.pdf`
      );
      await db.collection("loans").doc(loanId).update({
        contractUrl: url,
        contractGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db
        .collection("employees")
        .doc(employeeId)
        .collection("documents")
        .add({
          type: "loan_contract",
          loanId,
          url,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    if (type === "repayment_receipt") {
      const loan = (await db.collection("loans").doc(loanId).get()).data();
      const html =
        "<html><body style='font-family:Georgia;padding:40px;color:#1a2634'>" +
        "<h1 style='color:#194445;letter-spacing:4px'>V I D A</h1>" +
        "<h2>Comprobante de pago</h2>" +
        "<p>Folio: " + loanId.slice(0, 8).toUpperCase() + "</p>" +
        "<p>Empleado: " + loan.employeeName + "</p>" +
        "<p>Monto: $" + fmt(job.data.amount) + " MXN</p>" +
        "<p>Referencia: " +
        (job.data.chargeId || loan.repaymentRef || "-") +
        "</p>" +
        "<p>Fecha: " + new Date().toLocaleDateString("es-MX") + "</p>" +
        "<p style='color:#7a9898;font-size:11px'>Gracias por tu pago puntual</p>" +
        "<p style='color:#9aafaf;font-size:9px'>CONDUSEF 01800 999 8080</p></body></html>";
      const pdf = await renderPDF(html);
      const url = await upload(
        pdf,
        `loans/${loanId}/recibo_${Date.now()}.pdf`
      );
      await db.collection("loans").doc(loanId).update({
        receiptUrl: url,
        receiptGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  },
  { connection: redis, concurrency: 2 }
);

worker.on("failed", async (job, err) => {
  await db.collection("incident_log").add({
    source: "pdf-worker",
    error: err.message,
    loanId: job?.data?.loanId,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
});

// Periodic queue depth check (every 60s)
setInterval(async () => {
  try {
    const q = new Queue("vida-pdfs", { connection: redis });
    const depth = await q.getWaitingCount();
    await q.close();
    if (depth > 100) alertQueueDepth(SERVICE_NAME, "vida-pdfs", depth, 100);
  } catch (_) {}
}, 60_000);

/* ─── Express server ─── */

const requireInternal = (req, res, next) => {
  if (req.headers["x-internal-secret"] !== process.env.INTERNAL_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

const cors = require("cors");
const ALLOWED = ["https://vida-finance.web.app"];
const app = express();
app.use(helmet());
app.use(metricsMiddleware('vida-pdf-generator'));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Methods", "GET,POST"); res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-internal-secret"); return res.sendStatus(204); }
  next();
});
app.use(express.json({ limit: "100kb" }));

// 5xx alert interceptor
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 500) alert5xx(SERVICE_NAME, res.statusCode, req.path);
    return origJson(body);
  };
  next();
});

app.post("/contracts/generate", requireInternal, async (req, res) => {
  const { loanId, employeeId, metamapVerificationId } = req.body;
  if (!loanId || !employeeId) {
    return res.status(400).json({ error: "loanId and employeeId are required" });
  }

  try {
    const loan = (await db.collection("loans").doc(loanId).get()).data();
    assertLoanReadyForContract(loan, loanId);

    const { feePct, termDays, cat } = contractTerms(loan);
    const html = CONTRACT_TPL({
      loanId: loanId.slice(0, 8).toUpperCase(),
      issuedDate: new Date().toLocaleDateString("es-MX"),
      dueDate: loan.dueDate.toDate().toLocaleDateString("es-MX"),
      employeeName: loan.employeeName,
      employerName: loan.employerName,
      amount: fmt(loan.amount),
      fee: fmt(loan.fee),
      feePct,
      termDays,
      total: fmt(loan.total),
      cat,
      sofomRfc: process.env.SOFOM_RFC || "VIDA240101XXX",
      sofomAddress:
        process.env.SOFOM_ADDRESS ||
        "Paseo de la Reforma 250 Piso 12, CDMX",
    });
    const pdf = await renderPDF(html);
    const url = await upload(pdf, `loans/${loanId}/contrato_${Date.now()}.pdf`);

    let metamapDocumentId = null;
    let contractStatus = 'generated';
    let signatureError = null;
    try {
      const signing = require('./src/metamap-signing-client');
      if (signing.isEnabled() && metamapVerificationId) {
        const pdfBase64 = pdf.toString('base64');
        const result = await signing.createSignedDocument({
          loanId,
          metamapVerificationId,
          pdfBase64,
          signerEmail: loan.employeeEmail,
          signerName: loan.employeeName,
        });
        metamapDocumentId = result.documentId;
        contractStatus = 'awaiting_signature';
        log.info({ loanId, metamapDocumentId }, "Loan submitted for signing");
      }
    } catch (err) {
      // Distinct terminal status so a failed signature request is never
      // mistaken for "signing not attempted" -- both previously collapsed to
      // contractStatus: 'generated' / metamapDocumentId: null.
      console.error(`[metamap] Signing failed for loan ${loanId}:`, err.message);
      contractStatus = 'signature_request_failed';
      signatureError = err.message;
    }

    await db.collection("loans").doc(loanId).update({
      contractUrl: url,
      contractGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      metamapVerificationId: metamapVerificationId || null,
      metamapDocumentId,
      contractStatus,
      ...(signatureError
        ? { signatureError, signatureFailedAt: admin.firestore.FieldValue.serverTimestamp() }
        : {}),
    });
    await db
      .collection("employees")
      .doc(employeeId)
      .collection("documents")
      .add({
        type: "loan_contract",
        loanId,
        url,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ contractUrl: url });
  } catch (err) {
    if (err.code === "LOAN_NOT_FOUND") {
      return res.status(404).json({ error: "Loan not found" });
    }
    if (err.code === "LOAN_INVALID") {
      return res.status(422).json({ error: err.message });
    }
    console.error("Contract generation failed:", err);
    res.status(500).json({ error: "Contract generation failed" });
  }
});

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metricsRegister.contentType);
    res.end(await metricsRegister.metrics());
  } catch (err) {
    // Express 4 does not catch a rejected promise from an async route handler --
    // an unguarded await here would send no response at all instead of a 5xx.
    res.status(500).end('metrics_unavailable');
  }
});

app.get("/health", async (req, res) => {
  const redisOk = await redis
    .ping()
    .then(() => true)
    .catch(() => false);

  let firestoreOk = false;
  try { await db.collection("_health").limit(1).get(); firestoreOk = true; } catch (_) {}

  // Queue depth
  const queueDepth = {};
  try {
    const q = new Queue("vida-pdfs", { connection: redis });
    queueDepth.pdfs = await q.getWaitingCount();
    await q.close();
  } catch (_) { queueDepth.pdfs = -1; }

  const down = !redisOk && !firestoreOk;
  const degraded = !redisOk || !firestoreOk;
  res.status(down ? 503 : 200).json({
    status: down ? "down" : degraded ? "degraded" : "ok",
    service: "vida-pdf-generator",
    version: pkg.version,
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    redis: redisOk,
    firestore: firestoreOk,
    queue_depth: queueDepth,
    ts: new Date().toISOString(),
  });
});

if (require.main === module) {
  app.listen(process.env.PORT || 3004, () =>
    console.log("vida-pdf-generator on", process.env.PORT || 3004)
  );
}

module.exports = { app, worker };
