/**
 * bootstrap-super-admin.js
 *
 * Mints the `super_admin` custom claim on a single existing account.
 *
 * WHY THIS EXISTS
 * ---------------
 * `super_admin` is referenced as the top role throughout the platform
 * (authMiddleware.ts, firestore.rules, storage.rules, ~10 callables) but it is
 * NOT grantable through any API: setAdminClaim's schema
 * (functions/src/admin/adminClaims.ts) accepts only
 * employee | employer_admin | ops | admin, and adminClaims.test.ts asserts that
 * 'super_admin' is rejected. Verified 2026-08-02 for #389. So the role was
 * unreachable — no account could ever hold it.
 *
 * That gap is deliberate: the ceiling role must not be self-servable over the
 * web. This script is the out-of-band path instead. It is NOT a callable, is
 * not exported to Cloud Functions, is not reachable from the browser, and
 * cannot run without a Firebase service-account key that only an operator with
 * project-level IAM can obtain.
 *
 * USAGE
 * -----
 *   SA_KEY_PATH=/path/to/service-account.json \
 *     node scripts/bootstrap-super-admin.js <targetUid>
 *
 *   # dry run — resolves and prints the target, changes nothing
 *   SA_KEY_PATH=/path/to/service-account.json \
 *     node scripts/bootstrap-super-admin.js <targetUid> --dry-run
 *
 * The uid is a positional argument; there is no "grant to everyone matching X"
 * mode and no wildcard, on purpose. Run it once per intended principal.
 *
 * WHAT IT DOES
 * ------------
 *   1. Resolves <targetUid> in Firebase Auth (fails loudly if it does not exist).
 *   2. Writes an audit_log record — the same canonical shape every Cloud
 *      Function writer uses (functions/src/utils/auditLog.ts) — BEFORE minting.
 *      Same ordering as adminClaims.ts: a privilege grant that cannot be logged
 *      does not happen.
 *   3. Sets the custom claim { role: 'super_admin' }.
 *   4. Mirrors the role onto users/<uid> so the admin console and the
 *      Firestore-role fallbacks agree with the token.
 *
 * AFTERWARDS
 * ----------
 * Custom claims land in the user's ID token only on refresh. The operator must
 * sign out and back in (or force a token refresh) before the new role takes
 * effect. Note also that #389's two-person loan-config controls require TWO
 * DIFFERENT principals, so this must be run for at least two people before a
 * super_admin-only gate would be operable.
 */

const admin = require("firebase-admin");

const SUPER_ADMIN_ROLE = "super_admin";
const AUDIT_LOG_COLLECTION = "audit_log"; // keep in sync with functions/src/utils/auditLog.ts

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetUid = args.find((a) => !a.startsWith("--"));

if (!targetUid) {
  console.error("ERROR: a target uid is required.");
  console.error(
    "Usage: SA_KEY_PATH=/path/to/sa.json node scripts/bootstrap-super-admin.js <targetUid> [--dry-run]"
  );
  process.exit(1);
}

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

async function run() {
  const auth = admin.auth();
  const db = admin.firestore();

  // 1. The uid must already exist. Minting a claim on a typo'd uid would
  //    silently create a dangling grant nobody notices until it is used.
  let user;
  try {
    user = await auth.getUser(targetUid);
  } catch (err) {
    console.error(`ERROR: no Firebase Auth user with uid '${targetUid}' (${err.message})`);
    process.exit(1);
  }

  const previousRole = user.customClaims?.role ?? null;

  console.log(`Target : ${user.uid}  <${user.email || "no email"}>`);
  console.log(`Current: role=${JSON.stringify(previousRole)}`);
  console.log(`New    : role="${SUPER_ADMIN_ROLE}"`);

  if (previousRole === SUPER_ADMIN_ROLE) {
    console.log("\nAlready super_admin. Nothing to do.");
    return;
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    return;
  }

  const operator = process.env.OPERATOR || process.env.USER || "unknown-operator";

  // 2. Audit BEFORE the grant, matching adminClaims.ts.
  await db.collection(AUDIT_LOG_COLLECTION).add({
    action: "admin.bootstrapSuperAdmin",
    actorUid: `script:bootstrap-super-admin:${operator}`,
    actorRole: "operator",
    actorEmail: null,
    targetCollection: "admin",
    targetId: targetUid,
    before: { role: previousRole },
    after: { role: SUPER_ADMIN_ROLE },
    meta: {
      entityType: "user",
      source: "scripts/bootstrap-super-admin.js",
      note: "Out-of-band grant: super_admin is not grantable via setAdminClaim (#389).",
    },
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("\n[OK]  audit_log record written");

  // 3. Mint the claim.
  await auth.setCustomUserClaims(targetUid, { role: SUPER_ADMIN_ROLE });
  console.log("[OK]  custom claim set");

  // 4. Mirror onto the user document for the console / Firestore-role fallbacks.
  await db
    .collection("users")
    .doc(targetUid)
    .set(
      { role: SUPER_ADMIN_ROLE, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  console.log("[OK]  users/%s role mirrored", targetUid);

  console.log("\nDone. The user must sign out and back in for the new token to carry the role.");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
