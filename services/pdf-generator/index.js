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
require("dotenv").config();

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

const { sendPagareForSigning } = require("./src/mifiel-client");

const CONTRACT_TPL = Handlebars.compile(
  fs.readFileSync(path.join(__dirname, "templates", "contract.hbs"), "utf8")
);

const fmt = (n) =>
  Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2 });

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
      const cat = (
        (Math.pow(1 + loan.fee / loan.amount, 365 / 30) - 1) *
        100
      ).toFixed(0);
      const html = CONTRACT_TPL({
        loanId: loanId.slice(0, 8).toUpperCase(),
        issuedDate: new Date().toLocaleDateString("es-MX"),
        dueDate: loan.dueDate.toDate().toLocaleDateString("es-MX"),
        employeeName: loan.employeeName,
        employerName: loan.employerName,
        amount: fmt(loan.amount),
        fee: fmt(loan.fee),
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
  const { loanId, employeeId } = req.body;
  if (!loanId || !employeeId) {
    return res.status(400).json({ error: "loanId and employeeId are required" });
  }

  try {
    const loan = (await db.collection("loans").doc(loanId).get()).data();
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const cat = (
      (Math.pow(1 + loan.fee / loan.amount, 365 / 30) - 1) * 100
    ).toFixed(0);
    const html = CONTRACT_TPL({
      loanId: loanId.slice(0, 8).toUpperCase(),
      issuedDate: new Date().toLocaleDateString("es-MX"),
      dueDate: loan.dueDate.toDate().toLocaleDateString("es-MX"),
      employeeName: loan.employeeName,
      employerName: loan.employerName,
      amount: fmt(loan.amount),
      fee: fmt(loan.fee),
      total: fmt(loan.total),
      cat,
      sofomRfc: process.env.SOFOM_RFC || "VIDA240101XXX",
      sofomAddress:
        process.env.SOFOM_ADDRESS ||
        "Paseo de la Reforma 250 Piso 12, CDMX",
    });
    const pdf = await renderPDF(html);
    const url = await upload(pdf, `loans/${loanId}/contrato_${Date.now()}.pdf`);

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

    // Mifiel e-signature (if enabled and env configured)
    let mifielDocumentId = null;
    let mifielSigningUrl = null;
    const mifielEnabled = process.env.MIFIEL_ENABLED === 'true';
    if (mifielEnabled && process.env.MIFIEL_APP_ID && loan.employeeEmail && loan.employeeRfc) {
      try {
        const tmp = `/tmp/contract_${loanId}.pdf`;
        fs.writeFileSync(tmp, pdf);
        const mifielRes = await sendPagareForSigning({
          pdfPath: tmp,
          borrowerName: loan.employeeName,
          borrowerEmail: loan.employeeEmail,
          borrowerRfc: loan.employeeRfc,
          loanId,
        });
        mifielDocumentId = mifielRes.documentId;
        mifielSigningUrl = mifielRes.signingUrl;
        await db.collection("loans").doc(loanId).update({
          mifielDocumentId,
          mifielSigningUrl,
          mifielStatus: "sent_for_signing",
          mifielSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        try { fs.unlinkSync(tmp); } catch (_) {}
      } catch (mifielErr) {
        console.error("Mifiel send failed:", mifielErr.message);
        await db.collection("loans").doc(loanId).update({
          mifielStatus: "send_failed",
          mifielError: mifielErr.message,
        });
      }
    }

    res.json({ contractUrl: url, mifielDocumentId, mifielSigningUrl });
  } catch (err) {
    console.error("Contract generation failed:", err);
    res.status(500).json({ error: "Contract generation failed" });
  }
});

/**
 * Mifiel webhook callback. Fires when borrower completes e-signature.
 * Body: { id (document id), signed, file_signed, external_id (loanId) }
 */
app.post("/webhooks/mifiel/signed", async (req, res) => {
  const { id: mifielDocumentId, signed, file_signed, external_id: loanId, certificate_detail } = req.body || {};
  if (!loanId || !mifielDocumentId) {
    return res.status(400).json({ error: "loanId and documentId required" });
  }
  try {
    const update = {
      mifielStatus: signed ? "signed" : "webhook_received",
      mifielSignedAt: signed ? admin.firestore.FieldValue.serverTimestamp() : null,
    };
    if (file_signed) update.contractSignedUrl = file_signed;
    if (certificate_detail) update.mifielCertificate = certificate_detail;
    if (signed) update.status = "contract_signed";
    await db.collection("loans").doc(loanId).update(update);
    res.json({ ok: true, loanId, signed: !!signed });
  } catch (err) {
    console.error("Mifiel webhook handler failed:", err);
    res.status(500).json({ error: err.message });
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

app.listen(process.env.PORT || 3004, () =>
  console.log("vida-pdf-generator on", process.env.PORT || 3004)
);
