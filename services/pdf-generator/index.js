const express    = require("express");
const puppeteer  = require("puppeteer");
const admin      = require("firebase-admin");
const IORedis    = require("ioredis");
const { Worker } = require("bullmq");
const Handlebars = require("handlebars");
const fs         = require("fs");
const path       = require("path");
const { securityHeaders } = require("../shared/securityHeaders");
const { railwayCors } = require("../shared/cors");
const { apiRateLimit } = require("../shared/rateLimiter");
require("dotenv").config();

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

const CONTRACT_TPL = Handlebars.compile(
  fs.readFileSync(path.join(__dirname, "templates", "contract.hbs"), "utf8")
);

const fmt = (n) =>
  Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2 });

/* --- Puppeteer helpers --- */

let browser;
async function getBrowser() {
  if (!browser || !browser.connected)
    browser = await puppeteer.launch({
      headless: "new",
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

/* --- BullMQ Worker --- */

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

/* --- Express server --- */

const app = express();
app.use(securityHeaders);
app.use(railwayCors);
app.use(apiRateLimit);
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (req, res) => {
  const redisOk = await redis
    .ping()
    .then(() => true)
    .catch(() => false);
  res.json({
    status: redisOk ? "ok" : "degraded",
    service: "vida-pdf-generator",
    redis: redisOk,
    ts: new Date().toISOString(),
  });
});

app.listen(process.env.PORT || 3003, () =>
  console.log("vida-pdf-generator on", process.env.PORT || 3003)
);
