/**
 * seed-qa-employer.js
 *
 * Creates ONE clearly-labeled QA employer document (and its employerCodes
 * ledger reservation) so the mobile registration wizard has a company code
 * to test against. A Firestore document only — no Auth account, no password,
 * no payment rails touched.
 *
 * Safety posture, deliberately:
 *  - companyName says QA in Spanish so it can never be mistaken for a client;
 *  - status 'pending_verification' — satisfies both the employee-create rule
 *    and requestLoan's employer gate, so borrower flows behave realistically,
 *    but every loan still dies at IDENTITY_NOT_VERIFIED unless a real person
 *    completes real MetaMap KYC, and after that at manual review
 *    (ML_MODE=manual_review_all) — the human gates stay.
 *  - the code is reserved in the employerCodes ledger exactly like
 *    mintEmployerCode() does, inside a transaction, so it can never collide
 *    with a real employer's code (#568).
 *
 * USAGE
 *   SA_KEY_PATH=/path/to/service-account.json node scripts/seed-qa-employer.js
 *
 * Re-running is safe: if the doc already exists it prints the code and exits.
 */

const admin = require("firebase-admin");

const SA_KEY_PATH = process.env.SA_KEY_PATH || "/tmp/sa-key.json";
const AUDIT_LOG_COLLECTION = "audit_log";

const QA_EMPLOYER_ID = "qa-funpay-demo-employer";
const QA_EMPLOYER_CODE = "FUNQA1";

let serviceAccount;
try {
  serviceAccount = require(SA_KEY_PATH);
} catch {
  console.error(`ERROR: Service account key not found at ${SA_KEY_PATH}`);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const db = admin.firestore();
  const operator = process.env.OPERATOR || process.env.USER || "unknown-operator";
  const employerRef = db.collection("employers").doc(QA_EMPLOYER_ID);
  const reservationRef = db.collection("employerCodes").doc(QA_EMPLOYER_CODE);

  const existing = await employerRef.get();
  if (existing.exists) {
    console.log(`[EXISTS] employers/${QA_EMPLOYER_ID} — code: ${existing.data().employerCode}`);
    return;
  }

  const created = await db.runTransaction(async (tx) => {
    // Same double-registry uniqueness check as mintEmployerCode(): the ledger
    // AND the legacy book of client-minted codes on employer docs.
    const [reservation, inUse] = await Promise.all([
      tx.get(reservationRef),
      tx.get(db.collection("employers").where("employerCode", "==", QA_EMPLOYER_CODE).limit(1)),
    ]);
    if (reservation.exists || !inUse.empty) return false;

    tx.create(reservationRef, {
      employerId: QA_EMPLOYER_ID,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(employerRef, {
      companyName: "FunPay QA — interno, no usar",
      employerCode: QA_EMPLOYER_CODE,
      status: "pending_verification",
      totalEmployees: 0,
      isQaFixture: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (!created) {
    console.error(`ERROR: code ${QA_EMPLOYER_CODE} is already taken by another employer. Nothing written.`);
    process.exit(1);
  }

  await db.collection(AUDIT_LOG_COLLECTION).add({
    action: "admin.seedQaEmployer",
    actorUid: `script:seed-qa-employer:${operator}`,
    actorRole: "operator",
    actorEmail: null,
    targetCollection: "employers",
    targetId: QA_EMPLOYER_ID,
    before: null,
    after: { employerCode: QA_EMPLOYER_CODE, status: "pending_verification" },
    meta: {
      entityType: "employer",
      source: "scripts/seed-qa-employer.js",
      note: "QA fixture employer for mobile registration testing.",
    },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[CREATED] employers/${QA_EMPLOYER_ID}`);
  console.log(`QA company code: ${QA_EMPLOYER_CODE}`);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
