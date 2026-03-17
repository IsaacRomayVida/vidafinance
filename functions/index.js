const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const fetch = require("node-fetch");
const { nanoid } = require("nanoid");
const IORedis = require("ioredis");
const { Queue } = require("bullmq");

initializeApp();
const db = getFirestore();

// ── CORS whitelist for HTTP functions ──────────────────────────────
const ALLOWED_ORIGINS = [
  'https://app.vida.finance',
  'https://vida-finance-prod.web.app',
  'https://vida-finance-prod.firebaseapp.com',
  'https://staging.vida.finance',
  'https://vida-finance-staging.web.app',
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://localhost:3001']
    : []),
];

let _redis;
function getRedis() {
  if (!_redis) {
    _redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      tls: process.env.REDIS_URL?.startsWith("rediss://")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return _redis;
}

let _bullRedis;
function getBullRedis() {
  if (!_bullRedis) {
    _bullRedis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      tls: process.env.REDIS_URL?.startsWith("rediss://")
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return _bullRedis;
}

function getQueue(name) {
  return new Queue(name, { connection: getBullRedis() });
}

async function auditLog(database, { action, actorUid, actorRole, targetId, before = null, after = null, meta = {} }) {
  return database.collection("audit_log").add({
    action,
    actorUid,
    actorRole,
    targetCollection: action.split(".")[0],
    targetId,
    before,
    after,
    meta,
    timestamp: FieldValue.serverTimestamp(),
  });
}

async function callML(path, body) {
  const url = process.env.ML_SERVICE_URL;
  if (!url) throw new Error("ML_SERVICE_URL not configured");
  const r = await fetch(url + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": process.env.INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`ML ${path}: ${r.status}`);
  return r.json();
}

exports.api = onRequest({ cors: ALLOWED_ORIGINS }, async (req, res) => {
  if (req.path === "/api/health") {
    return res.json({ status: "ok", service: "vida-finance", timestamp: new Date().toISOString() });
  }
  return res.status(404).json({ error: "Not found" });
});

exports.requestLoan = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Login required");
  }
  const uid = request.auth.uid;
  const { amount, term } = request.data;

  // Rate limit: max 3 requests/hour via Redis
  try {
    const r = getRedis();
    const key = "rate:loans:" + uid;
    const cnt = await r.incr(key);
    if (cnt === 1) await r.expire(key, 3600);
    if (cnt > 3)
      throw new HttpsError("resource-exhausted", "Máximo 3 solicitudes por hora");
  } catch (e) {
    if (e.code) throw e;
    console.warn("Redis rate limit unavailable:", e.message);
  }

  if (typeof amount !== "number" || amount < 500 || amount > 5000)
    throw new HttpsError("invalid-argument", "El monto debe estar entre $500 y $5,000 MXN");
  if (term !== 30)
    throw new HttpsError("invalid-argument", "Plazo inválido");

  const empRef = db.collection("employees").doc(uid);
  const emplDoc = await empRef.get();
  if (!emplDoc.exists) throw new HttpsError("not-found", "Empleado no encontrado");
  const emp = emplDoc.data();

  if (amount > emp.availableCredit)
    throw new HttpsError("invalid-argument", "El monto excede tu crédito disponible");
  if (amount > Math.round(emp.monthlySalary * 0.3))
    throw new HttpsError("invalid-argument", "El monto excede el 30% de tu salario mensual");

  const active = await db
    .collection("loans")
    .where("employeeId", "==", uid)
    .where("status", "in", ["pending", "approved", "active"])
    .limit(1)
    .get();
  if (!active.empty)
    throw new HttpsError("failed-precondition", "Ya tienes un préstamo activo o pendiente");

  const employerSnap = await db.collection("employers").doc(emp.employerId).get();
  const employer = employerSnap.data();

  const loanId = nanoid();
  const fee = Math.round(amount * 0.3);
  const dueDate = Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  // ML underwriting (best-effort)
  const loanExtra = {};
  try {
    const ml = await callML("/underwrite/employee", {
      employeeId: uid,
      monthlySalary: emp.monthlySalary || 0,
      employerTier: employer.riskTier || 2,
      existingLoans: 0,
      bankClabe: emp.bankClabe || null,
      amount,
      requestsLastHour: 0,
    });
    if (ml.fraud && ml.fraud.is_fraud)
      throw new HttpsError("permission-denied", "Solicitud marcada como sospechosa");
    if (ml.default_probability > 0.4)
      throw new HttpsError("failed-precondition", "No es posible aprobar tu solicitud en este momento");
    Object.assign(loanExtra, {
      mlDecisionId: ml.decisionId,
      mlCreditScore: ml.credit_score,
      mlDefaultProb: ml.default_probability,
    });
  } catch (e) {
    if (e.code) throw e;
    console.warn("ML unavailable:", e.message);
  }

  await db.runTransaction(async (tx) => {
    tx.update(empRef, { availableCredit: FieldValue.increment(-amount) });
    tx.set(db.collection("loans").doc(loanId), {
      employeeId: uid,
      employeeName: emp.name,
      employeeEmail: emp.email,
      employeePhone: emp.phone || null,
      employerId: emp.employerId,
      employerName: emp.employerName,
      employerCode: employer.employerCode,
      amount,
      fee,
      total: amount + fee,
      term: 30,
      status: "pending",
      dueDate,
      disbursedAt: null,
      disbursementRef: null,
      disbursementError: null,
      paidAt: null,
      paidAmount: null,
      repaymentRef: null,
      conektaOrderId: null,
      paymentUrl: null,
      paymentLinkGeneratedAt: null,
      overdueDetectedAt: null,
      softcreditoDeductionId: null,
      contractUrl: null,
      receiptUrl: null,
      ...loanExtra,
      acceptedIp: request.rawRequest?.ip || null,
      acceptedUserAgent: request.rawRequest?.headers?.["user-agent"] || null,
      acceptedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  try {
    await auditLog(db, { action: "loan.requested", actorUid: uid, actorRole: "employee", targetId: loanId });
  } catch (_) { /* non-critical */ }

  return { loanId, status: "pending", total: amount + fee, dueDate: dueDate.toDate().toISOString() };
});

exports.onLoanStatusChange = onDocumentUpdated("loans/{loanId}", async (event) => {
  const beforeData = event.data.before.data();
  const afterData = event.data.after.data();
  const loanId = event.params.loanId;

  if (beforeData.status === "pending" && afterData.status === "approved") {
    await db.collection("employers").doc(afterData.employerId).update({
      activeLoans: FieldValue.increment(1),
      totalDisbursed: FieldValue.increment(afterData.amount),
    });
    try {
      await auditLog(db, {
        action: "loan.approved",
        actorUid: afterData.employerId,
        actorRole: "employer",
        targetId: loanId,
        before: { status: "pending" },
        after: { status: "approved" },
      });
    } catch (_) { /* non-critical */ }
  }

  if (beforeData.status === "pending" && afterData.status === "rejected") {
    await db.collection("employees").doc(afterData.employeeId).update({
      availableCredit: FieldValue.increment(afterData.amount),
    });
    try {
      await auditLog(db, {
        action: "loan.rejected",
        actorUid: afterData.employerId,
        actorRole: "employer",
        targetId: loanId,
        before: { status: "pending" },
        after: { status: "rejected" },
      });
    } catch (_) { /* non-critical */ }
  }

  if (beforeData.status === "approved" && afterData.status === "paid") {
    await db.collection("employers").doc(afterData.employerId).update({
      activeLoans: FieldValue.increment(-1),
    });
    await db.collection("employees").doc(afterData.employeeId).update({
      availableCredit: FieldValue.increment(afterData.amount),
    });
    try {
      await auditLog(db, {
        action: "loan.repaid",
        actorUid: afterData.employeeId,
        actorRole: "employee",
        targetId: loanId,
        before: { status: "approved" },
        after: { status: "paid" },
      });
    } catch (_) { /* non-critical */ }
  }
});

// ── onLoanApproved — fires when employer approves ──────────────────────
exports.onLoanApproved = onDocumentUpdated("loans/{loanId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!(before.status === "pending" && after.status === "approved")) return null;

  const loanId = event.params.loanId;
  const emp = (await db.collection("employees").doc(after.employeeId).get()).data();

  await db.collection("disbursement_queue").doc(loanId).set({
    loanId,
    employeeId: after.employeeId,
    employeeName: after.employeeName,
    employerName: after.employerName,
    amount: after.amount,
    total: after.total,
    clabe: emp.bankClabe || null,
    bankName: emp.bankName || null,
    concept: "VIDA-" + loanId.slice(0, 8).toUpperCase(),
    status: "queued",
    queuedAt: FieldValue.serverTimestamp(),
  });
  await db.collection("loans").doc(loanId).update({ status: "disbursement_queued" });

  try {
    await getQueue("vida-disbursements").add("disburse", {
      loanId,
      employeeId: after.employeeId,
      amount: after.amount,
      clabe: emp.bankClabe,
      concept: "VIDA-" + loanId.slice(0, 8).toUpperCase(),
      employeeName: after.employeeName,
      employerName: after.employerName,
    });
    await getQueue("vida-notifications").add("loan_approved", {
      type: "loan_approved",
      loanId,
      employeeId: after.employeeId,
      employeeName: after.employeeName,
      phone: emp.phone,
      amount: after.amount,
    });
    await getQueue("vida-pdfs").add("loan_contract", {
      type: "loan_contract",
      loanId,
      employeeId: after.employeeId,
      employeeName: after.employeeName,
      employerName: after.employerName,
      amount: after.amount,
      total: after.total,
      fee: after.fee,
      dueDate: after.dueDate.toDate().toISOString(),
    });
  } catch (e) {
    console.warn("Queue unavailable:", e.message);
  }

  try {
    await auditLog(db, {
      action: "loan.approved",
      actorUid: after.employerId,
      actorRole: "employer",
      targetId: loanId,
      before: { status: "pending" },
      after: { status: "approved" },
    });
  } catch (_) { /* non-critical */ }

  return null;
});

// ── markLoanDisbursed — admin only ────────────────────────────────────
exports.markLoanDisbursed = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth?.token?.admin)
    throw new HttpsError("permission-denied", "Admin only");

  const { loanId, disbursementRef } = request.data;
  const loanSnap = await db.collection("loans").doc(loanId).get();
  if (!loanSnap.exists) throw new HttpsError("not-found", "Loan not found");
  const loan = loanSnap.data();

  await db.collection("loans").doc(loanId).update({
    status: "active",
    disbursedAt: FieldValue.serverTimestamp(),
    disbursementRef,
  });
  await db.collection("disbursement_queue").doc(loanId).update({
    status: "completed",
    completedAt: FieldValue.serverTimestamp(),
  });

  try {
    await getQueue("vida-notifications").add("loan_disbursed", {
      type: "loan_disbursed",
      loanId,
      employeeId: loan.employeeId,
      amount: loan.amount,
      disbursementRef,
      phone: loan.employeePhone,
    });
  } catch (e) {
    console.warn("Queue unavailable:", e.message);
  }

  try {
    await auditLog(db, {
      action: "loan.disbursed",
      actorUid: request.auth.uid,
      actorRole: "admin",
      targetId: loanId,
      after: { status: "active", disbursementRef },
    });
  } catch (_) { /* non-critical */ }

  return { success: true };
});

// ── generatePaymentLink ───────────────────────────────────────────────
exports.generatePaymentLink = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");

  const { loanId } = request.data;
  const loanDoc = await db.collection("loans").doc(loanId).get();
  if (!loanDoc.exists) throw new HttpsError("not-found", "Loan not found");
  const loan = loanDoc.data();

  if (loan.employeeId !== request.auth.uid)
    throw new HttpsError("permission-denied", "Not your loan");
  if (!["active", "overdue"].includes(loan.status))
    throw new HttpsError("failed-precondition", "Loan not payable");

  if (
    loan.paymentUrl &&
    loan.paymentLinkGeneratedAt &&
    Date.now() - loan.paymentLinkGeneratedAt.toMillis() < 23 * 60 * 60 * 1000
  ) {
    return { paymentUrl: loan.paymentUrl };
  }

  const b64 = Buffer.from(process.env.CONEKTA_API_KEY + ":").toString("base64");
  const resp = await fetch("https://api.conekta.io/orders", {
    method: "POST",
    headers: {
      Authorization: "Basic " + b64,
      "Content-Type": "application/json",
      Accept: "application/vnd.conekta-v2.1.0+json",
    },
    body: JSON.stringify({
      currency: "MXN",
      customer_info: {
        name: loan.employeeName,
        email: loan.employeeEmail,
        phone: "0000000000",
      },
      line_items: [
        {
          name: "Pago préstamo VIDA " + loanId.slice(0, 8).toUpperCase(),
          unit_price: Math.round(loan.total * 100),
          quantity: 1,
        },
      ],
      checkout: {
        type: "HostedPayment",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      },
      metadata: { loanId, employeeId: loan.employeeId },
    }),
  });

  const order = await resp.json();
  if (!resp.ok)
    throw new HttpsError("internal", order.details?.[0]?.message || "Conekta error");

  await db.collection("loans").doc(loanId).update({
    conektaOrderId: order.id,
    paymentUrl: order.checkout.url,
    paymentLinkGeneratedAt: FieldValue.serverTimestamp(),
  });

  try {
    await auditLog(db, {
      action: "payment_link.generated",
      actorUid: request.auth.uid,
      actorRole: "employee",
      targetId: loanId,
    });
  } catch (_) { /* non-critical */ }

  return { paymentUrl: order.checkout.url };
});

// ── dailyLoanCheck — 09:00 CST every day ──────────────────────────────
exports.dailyLoanCheck = onSchedule(
  { schedule: "0 9 * * *", timeZone: "America/Mexico_City" },
  async () => {
    const now = Timestamp.now();

    const overdueSnap = await db
      .collection("loans")
      .where("status", "==", "active")
      .where("dueDate", "<", now)
      .get();

    for (const doc of overdueSnap.docs) {
      const loan = doc.data();
      const daysOver = Math.floor((Date.now() - loan.dueDate.toMillis()) / 86400000);

      await doc.ref.update({ status: "overdue", overdueDetectedAt: now });

      await db.collection("overdue_log").doc(doc.id).set({
        loanId: doc.id,
        employeeId: loan.employeeId,
        employerId: loan.employerId,
        employeeName: loan.employeeName,
        amount: loan.total,
        dueDate: loan.dueDate,
        daysOverdue: daysOver,
        detectedAt: now,
        resolved: false,
      });

      try {
        await getQueue("vida-notifications").add("loan_overdue", {
          type: "loan_overdue",
          loanId: doc.id,
          employeeId: loan.employeeId,
          phone: loan.employeePhone,
          amount: loan.total,
          dueDate: loan.dueDate.toDate().toISOString(),
          daysOverdue: daysOver,
        });
      } catch (_) { /* queue unavailable */ }

      try {
        await auditLog(db, {
          action: "loan.overdue_detected",
          actorUid: "system",
          actorRole: "system",
          targetId: doc.id,
        });
      } catch (_) { /* non-critical */ }
    }

    // 24h reminders for loans due within next 25 hours
    const tomorrow = Timestamp.fromMillis(Date.now() + 25 * 60 * 60 * 1000);
    const remindSnap = await db
      .collection("loans")
      .where("status", "==", "active")
      .where("dueDate", "<", tomorrow)
      .get();

    for (const doc of remindSnap.docs) {
      if (doc.data().dueDate.toMillis() < Date.now()) continue;
      const loan = doc.data();
      try {
        await getQueue("vida-notifications").add("loan_reminder_24h", {
          type: "loan_reminder_24h",
          loanId: doc.id,
          employeeId: loan.employeeId,
          phone: loan.employeePhone,
          amount: loan.total,
          dueDate: loan.dueDate.toDate().toISOString(),
        });
      } catch (_) { /* queue unavailable */ }
    }

    await db.collection("scheduler_runs").add({
      job: "dailyLoanCheck",
      ranAt: now,
      overdueFound: overdueSnap.size,
      status: "complete",
    });
  }
);

// ── weeklyPortfolioSnapshot — Monday 08:00 CST ────────────────────────
exports.weeklyPortfolioSnapshot = onSchedule(
  { schedule: "0 8 * * 1", timeZone: "America/Mexico_City" },
  async () => {
    const snap = await db.collection("loans").get();
    const loans = snap.docs.map((d) => d.data());

    const cnt = (s) => loans.filter((l) => l.status === s).length;
    const sum = (s) => loans.filter((l) => l.status === s).reduce((a, l) => a + (l.amount || 0), 0);

    const active = cnt("active");
    const overdue = cnt("overdue");
    const paid = cnt("paid");
    const total = active + overdue + paid;
    const date = new Date().toISOString().split("T")[0];

    await db.collection("portfolio_snapshots").doc(date).set({
      snapshotDate: date,
      totalActive: active,
      totalOverdue: overdue,
      totalPaid: paid,
      totalDisbursedMXN: sum("active") + sum("overdue") + sum("paid"),
      totalOutstandingMXN: sum("active") + sum("overdue"),
      overdueRate: total > 0 ? overdue / total : 0,
      snapshotAt: FieldValue.serverTimestamp(),
    });
  }
);

// ── systemHealthCheck — every 5 minutes ───────────────────────────────
exports.systemHealthCheck = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "America/Mexico_City" },
  async () => {
    const services = [
      { name: "payment-server", url: process.env.PAYMENT_SERVER_URL + "/health" },
      { name: "softcredito-adapter", url: process.env.SOFTCREDITO_ADAPTER_URL + "/health" },
      { name: "notification-service", url: process.env.NOTIFICATION_SERVICE_URL + "/health" },
      { name: "pdf-generator", url: process.env.PDF_GENERATOR_URL + "/health" },
      { name: "ml-service", url: process.env.ML_SERVICE_URL + "/health" },
    ];

    const results = await Promise.allSettled(
      services.map(async (s) => {
        const start = Date.now();
        const r = await fetch(s.url, { signal: AbortSignal.timeout(6000) });
        const d = await r.json();
        return { name: s.name, status: d.status, redis: d.redis, latencyMs: Date.now() - start };
      })
    );

    const data = {};
    const ts = FieldValue.serverTimestamp();

    for (let i = 0; i < services.length; i++) {
      const res = results[i];
      data[services[i].name] =
        res.status === "fulfilled"
          ? { ...res.value, checkedAt: ts }
          : { status: "down", error: res.reason.message, checkedAt: ts };

      if (res.status === "rejected") {
        await db.collection("incident_log").add({
          source: "health-check",
          service: services[i].name,
          error: res.reason.message,
          severity: "critical",
          ts,
          resolved: false,
        });
      }
    }

    await db.collection("system_health").doc("current").set({ ...data, lastChecked: ts });
  }
);

// ── queueHealthCheck — every 2 minutes ────────────────────────────────
exports.queueHealthCheck = onSchedule(
  { schedule: "*/2 * * * *", timeZone: "America/Mexico_City" },
  async () => {
    try {
      const r = await fetch(process.env.PAYMENT_SERVER_URL + "/internal/queue-stats", {
        headers: { "x-internal-secret": process.env.INTERNAL_SECRET },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return;

      const d = await r.json();
      const ts = FieldValue.serverTimestamp();

      await db.collection("system_health").doc("queues").set({ ...d.queues, checkedAt: ts });

      for (const [name, stats] of Object.entries(d.queues)) {
        if (stats.failed > 50) {
          await db.collection("incident_log").add({
            source: "queue-monitor",
            queue: name,
            failedCount: stats.failed,
            severity: "warning",
            ts,
            resolved: false,
          });
        }
      }
    } catch (e) {
      console.warn("Queue health check failed:", e.message);
    }
  }
);

// ── approveEmployer — admin only ──────────────────────────────────────
exports.approveEmployer = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth?.token?.admin)
    throw new HttpsError("permission-denied", "Admin only");

  const { employerUid } = request.data;
  const empDoc = await db.collection("employers").doc(employerUid).get();
  if (!empDoc.exists) throw new HttpsError("not-found", "Employer not found");
  const emp = empDoc.data();

  await db.collection("employers").doc(employerUid).update({
    status: "active",
    activatedAt: FieldValue.serverTimestamp(),
  });

  // ML employer scoring (best-effort)
  try {
    const ml = await callML("/underwrite/employer", {
      employerUid,
      companyName: emp.companyName,
      companySize: emp.companySize,
      payrollSystem: emp.payrollSystem,
      yearsActive: emp.yearsActive || 0,
      satStatus: emp.satStatus || "unknown",
      industry: emp.industry || "unknown",
    });

    await db.collection("employers").doc(employerUid).update({
      riskTier: ml.risk_tier,
      mlScore: ml.score,
      mlDecisionId: ml.decisionId,
      llmAnalysis: ml.llm_analysis,
      mlScoredAt: FieldValue.serverTimestamp(),
    });

    if (ml.reject && !ml.llm_analysis?.escalate_to_human) {
      await db.collection("employers").doc(employerUid).update({
        status: "rejected_ml",
      });
      return { approved: false, reason: "No cumple requisitos de riesgo" };
    }
  } catch (e) {
    console.warn("ML scoring unavailable:", e.message);
  }

  // Register with SoftCrédito
  try {
    await fetch(process.env.SOFTCREDITO_ADAPTER_URL + "/internal/register-employer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": process.env.INTERNAL_SECRET,
      },
      body: JSON.stringify({
        employerUid,
        companyName: emp.companyName,
        rfc: emp.rfc || null,
        clabe: emp.bankClabe || null,
        contactEmail: emp.email,
      }),
    });
  } catch (e) {
    console.warn("SoftCrédito registration warning:", e.message);
  }

  // Notify employer
  try {
    await getQueue("vida-notifications").add("employer_activated", {
      type: "employer_activated",
      employerUid,
      email: emp.email,
      name: emp.name,
      companyName: emp.companyName,
      employerCode: emp.employerCode,
    });
  } catch (e) {
    console.warn("Notification queue unavailable:", e.message);
  }

  try {
    await auditLog(db, {
      action: "employer.approved",
      actorUid: request.auth.uid,
      actorRole: "admin",
      targetId: employerUid,
    });
  } catch (_) { /* non-critical */ }

  return { success: true, approved: true };
});

// ── setAdminClaim — admin only ────────────────────────────────────────
exports.setAdminClaim = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth?.token?.admin)
    throw new HttpsError("permission-denied", "Admin only");
  await getAuth().setCustomUserClaims(request.data.uid, { admin: true });
  return { success: true };
});

// ── revokeAdminClaim — admin only ─────────────────────────────────────
exports.revokeAdminClaim = onCall({ cors: ALLOWED_ORIGINS, enforceAppCheck: true }, async (request) => {
  if (!request.auth?.token?.admin)
    throw new HttpsError("permission-denied", "Admin only");
  await getAuth().setCustomUserClaims(request.data.uid, { admin: false });
  return { success: true };
});
