/**
 * set-employer-claims.js
 *
 * Sets employer_admin custom claims on existing test employer accounts.
 * The Cloud Function onEmployerDocCreated only triggers on NEW docs,
 * so existing accounts need retroactive claims via this script.
 *
 * Usage:
 *   SA_KEY_PATH=/tmp/sa-key.json node scripts/set-employer-claims.js
 *
 * Requires a Firebase service account key JSON file.
 */

const admin = require("firebase-admin");

const SA_KEY_PATH = process.env.SA_KEY_PATH || "/tmp/sa-key.json";

let serviceAccount;
try {
  serviceAccount = require(SA_KEY_PATH);
} catch {
  console.error(`ERROR: Service account key not found at ${SA_KEY_PATH}`);
  console.error("Set SA_KEY_PATH env var or place the key at /tmp/sa-key.json");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Test employer UIDs that need employer_admin claims
const TARGET_UIDS = [
  "H2vNoHKSHpZGYvXXgB3Oed1PXFh1", // test-employer-1774134933675
];

async function run() {
  console.log(`Setting employer_admin claims on ${TARGET_UIDS.length} account(s)...\n`);

  for (const uid of TARGET_UIDS) {
    try {
      await admin.auth().setCustomUserClaims(uid, { role: "employer_admin" });
      const user = await admin.auth().getUser(uid);
      console.log(`[OK]  ${uid}  claims: ${JSON.stringify(user.customClaims)}`);
    } catch (err) {
      console.error(`[ERR] ${uid}  ${err.message}`);
    }
  }

  console.log("\nDone.");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
