/**
 * bootstrap-test-accounts.js
 *
 * Creates one Firebase Auth user per role (employee, employer_admin, ops,
 * admin, super_admin) on the vida-finance project, mints the matching
 * `role` custom claim, and mirrors it onto users/<uid> — the same two
 * sources of truth authMiddleware.ts and the admin console read (see
 * scripts/bootstrap-super-admin.js for the precedent this follows).
 *
 * This bypasses the setAdminClaim callable on purpose: that callable
 * requires an existing admin/super_admin caller, and none exist yet.
 * super_admin in particular is only reachable out-of-band (see
 * bootstrap-super-admin.js's header) — this script IS that out-of-band path,
 * generalized to bootstrap all five roles from a cold start.
 *
 * USAGE
 * -----
 *   SA_KEY_PATH=/path/to/service-account.json node scripts/bootstrap-test-accounts.js
 *
 *   # dry run — prints what would be created/changed, writes nothing
 *   SA_KEY_PATH=/path/to/service-account.json node scripts/bootstrap-test-accounts.js --dry-run
 *
 * Re-running is safe: existing accounts are left alone (their existing
 * password is NOT reset) but their claim + users/<uid> mirror are
 * (re)synced to the role this script expects.
 *
 * OUTPUT
 * ------
 * Prints the 5 email/password pairs to stdout at the end. Nothing is written
 * to a file — copy them from the terminal.
 */

const admin = require("firebase-admin");
const crypto = require("crypto");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const SA_KEY_PATH = process.env.SA_KEY_PATH || "/tmp/sa-key.json";
const AUDIT_LOG_COLLECTION = "audit_log"; // keep in sync with functions/src/utils/auditLog.ts

let serviceAccount;
try {
  serviceAccount = require(SA_KEY_PATH);
} catch {
  console.error(`ERROR: Service account key not found at ${SA_KEY_PATH}`);
  console.error("Set SA_KEY_PATH env var or place the key at /tmp/sa-key.json");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

function genPassword() {
  // 16 random bytes -> base64url, trimmed to 20 chars. Meets any reasonable
  // Firebase Auth password policy without special-char surprises.
  return crypto.randomBytes(16).toString("base64url").slice(0, 20);
}

const ROLES = ["employee", "employer_admin", "ops", "admin", "super_admin"];

const ACCOUNTS = ROLES.map((role) => ({
  role,
  email: `test-${role.replace(/_/g, "-")}@vida-finance-test.internal`,
  displayName: `Test ${role}`,
}));

async function run() {
  const auth = admin.auth();
  const db = admin.firestore();
  const operator = process.env.OPERATOR || process.env.USER || "unknown-operator";
  const results = [];

  for (const acct of ACCOUNTS) {
    let user;
    let password = null;
    let created = false;

    try {
      user = await auth.getUserByEmail(acct.email);
      console.log(`[EXISTS] ${acct.email} (uid=${user.uid}) — leaving password as-is`);
    } catch {
      password = genPassword();
      created = true;
      if (dryRun) {
        console.log(`[DRY-RUN] would create ${acct.email} with role=${acct.role}`);
        results.push({ ...acct, password: "(dry-run, not created)" });
        continue;
      }
      user = await auth.createUser({
        email: acct.email,
        password,
        displayName: acct.displayName,
        emailVerified: true,
      });
      console.log(`[CREATED] ${acct.email} (uid=${user.uid})`);
    }

    if (dryRun) {
      console.log(`[DRY-RUN] would set role=${acct.role} on ${acct.email}`);
      continue;
    }

    const previousRole = user.customClaims?.role ?? null;

    await db.collection(AUDIT_LOG_COLLECTION).add({
      action: "admin.bootstrapTestAccount",
      actorUid: `script:bootstrap-test-accounts:${operator}`,
      actorRole: "operator",
      actorEmail: null,
      targetCollection: "users",
      targetId: user.uid,
      before: { role: previousRole },
      after: { role: acct.role },
      meta: {
        entityType: "user",
        source: "scripts/bootstrap-test-accounts.js",
        note: "Manual QA test account bootstrap.",
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auth.setCustomUserClaims(user.uid, { role: acct.role });

    await db
      .collection("users")
      .doc(user.uid)
      .set(
        {
          email: acct.email,
          role: acct.role,
          displayName: acct.displayName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    console.log(`[OK] ${acct.email} role=${acct.role} claim + users/${user.uid} synced`);

    results.push({
      role: acct.role,
      email: acct.email,
      password: created ? password : "(already existed — unchanged, you already have it)",
    });
  }

  if (dryRun) {
    console.log("\n--dry-run: no accounts created, no claims changed.");
    return;
  }

  console.log("\n================ TEST ACCOUNTS ================");
  for (const r of results) {
    console.log(`${r.role.padEnd(15)} ${r.email.padEnd(45)} ${r.password}`);
  }
  console.log("=================================================");
  console.log(
    "\nNote: custom claims land in the ID token only on next sign-in / token refresh."
  );
  console.log("If you test right after creation, the first login is what picks up the role.");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
