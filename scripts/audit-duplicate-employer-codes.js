/**
 * audit-duplicate-employer-codes.js
 *
 * READ-ONLY. Finds `employers` documents that share the same `employerCode`
 * and reports which of each duplicate group looks legitimate versus
 * squatted. Writes nothing — not to Firestore, not to a file.
 *
 * WHY THIS EXISTS
 * ---------------
 * #568 made new employer codes server-minted and reserved in the
 * `employerCodes` ledger, and `lookupEmployerByCode` now fails closed
 * (`failed-precondition`, logged via `logger.error`) instead of silently
 * picking a winner when a code resolves to more than one employer. Neither
 * of those fixes touches the *existing* book: every code minted by the old
 * client-side generator (Onboarding.tsx's `generateEmployerCode`, now
 * deleted) was written straight onto the employer document with no
 * uniqueness check at all, and the `employerCodes` ledger has no record of
 * any of them. If a collision — accidental or a deliberate squat performed
 * before #568 landed — already exists in production, `lookupEmployerByCode`
 * will now refuse it instead of misrouting it, which means a real company's
 * employees cannot self-register until an operator resolves the duplicate
 * by hand. This script is how an operator finds those duplicates without
 * waiting for an employee to hit the wall first.
 *
 * WHAT IT DOES
 * ------------
 *   1. Reads every `employers` document (id, employerCode, companyName,
 *      status, createdAt).
 *   2. Groups by employerCode; reports only groups with more than one
 *      document — a group of one is by definition not a collision.
 *   3. Within each group, ranks documents by a legitimacy heuristic and
 *      labels the rest as suspect:
 *        - status in {approved, active} outranks any other status, since
 *          those are the statuses ADMIN_APPROVED_EMPLOYER_STATUSES in
 *          index.ts requires before an employer can transact — a squat
 *          created to harvest employee PII has no reason to also pass a
 *          human admin review.
 *        - among ties, the earlier `createdAt` outranks the later one: the
 *          squat in #568's attack has to be registered AFTER the real
 *          company already had employees using the code.
 *      This is a heuristic for a human to start from, not a verdict — the
 *      script recommends, it does not decide, and it changes nothing.
 *
 * USAGE
 * -----
 *   SA_KEY_PATH=/path/to/service-account.json \
 *     node scripts/audit-duplicate-employer-codes.js
 *
 *   # machine-readable
 *   SA_KEY_PATH=/path/to/service-account.json \
 *     node scripts/audit-duplicate-employer-codes.js --json
 *
 * EXIT CODES
 * ----------
 *   0 — ran successfully, no duplicates found
 *   1 — script/auth error (could not read the collection)
 *   2 — ran successfully, duplicates found (for CI/alerting to key off)
 */

const admin = require("firebase-admin");

const APPROVED_STATUSES = new Set(["approved", "active"]);

const args = process.argv.slice(2);
const asJson = args.includes("--json");

const SA_KEY_PATH = process.env.SA_KEY_PATH || "/tmp/sa-key.json";

let serviceAccount;
try {
  serviceAccount = require(SA_KEY_PATH);
} catch {
  console.error(`ERROR: Service account key not found at ${SA_KEY_PATH}`);
  console.error("Set SA_KEY_PATH env var or place the key at /tmp/sa-key.json");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

function rankDoc(doc) {
  // Lower rank sorts first = looks more legitimate. Tuple compare:
  // (not-approved-status, createdAt millis).
  const approvedRank = APPROVED_STATUSES.has(doc.status) ? 0 : 1;
  const createdMillis =
    doc.createdAt && typeof doc.createdAt.toMillis === "function"
      ? doc.createdAt.toMillis()
      : Number.POSITIVE_INFINITY; // no timestamp sorts last, not first
  return [approvedRank, createdMillis];
}

function compareDocs(a, b) {
  const [ra, ca] = rankDoc(a);
  const [rb, cb] = rankDoc(b);
  if (ra !== rb) return ra - rb;
  return ca - cb;
}

async function run() {
  const db = admin.firestore();

  // Read-only: a single collection-wide get(), no writes anywhere in this
  // file. `employerCode` is not indexed for a `group by`-style query, so
  // this necessarily reads every employer document — acceptable for an
  // operator-run audit script, not something to expose as a callable.
  const snap = await db.collection("employers").get();

  const byCode = new Map();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const code = data.employerCode;
    if (!code) continue; // pre-#385 employers with no code yet are not a collision
    const entry = {
      id: doc.id,
      employerCode: code,
      companyName: data.companyName ?? "(no companyName)",
      status: data.status ?? "(no status)",
      createdAt: data.createdAt ?? null,
    };
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(entry);
  }

  const duplicateGroups = [...byCode.entries()]
    .filter(([, docs]) => docs.length > 1)
    .map(([code, docs]) => {
      const ranked = [...docs].sort(compareDocs);
      return {
        employerCode: code,
        documents: ranked.map((d, i) => ({
          employerId: d.id,
          companyName: d.companyName,
          status: d.status,
          createdAt:
            d.createdAt && typeof d.createdAt.toDate === "function"
              ? d.createdAt.toDate().toISOString()
              : null,
          verdict: i === 0 ? "likely legitimate" : "likely squatted",
        })),
      };
    });

  if (asJson) {
    console.log(JSON.stringify({ scanned: snap.size, duplicateGroups }, null, 2));
  } else {
    console.log(`Scanned ${snap.size} employer documents.`);
    if (duplicateGroups.length === 0) {
      console.log("No duplicate employerCode values found.");
    } else {
      console.log(
        `\nFound ${duplicateGroups.length} employerCode value(s) shared by more than one employer:\n`
      );
      for (const group of duplicateGroups) {
        console.log(`  employerCode = ${group.employerCode}`);
        for (const d of group.documents) {
          console.log(
            `    [${d.verdict}] ${d.employerId}  status=${d.status}  createdAt=${d.createdAt ?? "unknown"}  companyName="${d.companyName}"`
          );
        }
        console.log("");
      }
      console.log(
        "The 'likely squatted' documents are a starting point for manual review, not an" +
          " automated verdict — this script changes nothing. lookupEmployerByCode now" +
          " refuses (failed-precondition) any code in this list rather than silently" +
          " routing to one of them, so the real company's employees cannot self-register" +
          " with this code until an operator resolves the duplicate (e.g. clearing" +
          " employerCode on the squatted document so a fresh code can be minted via" +
          " ensureEmployerCode)."
      );
    }
  }

  return duplicateGroups.length;
}

run()
  .then((duplicateCount) => process.exit(duplicateCount > 0 ? 2 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
