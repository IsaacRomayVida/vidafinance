/**
 * seed-portal-test-accounts.js
 *
 * Creates the two sign-in accounts the team portal is missing: one
 * employer_admin for the QA employer fixture, and one ops account for the
 * operations console. The employee side already has an account (created
 * through the app's own signup wizard), so this script does not touch it.
 *
 * WHY THE EMPLOYER UID IS PINNED
 * ------------------------------
 * Across this codebase an employer_admin's Auth uid IS the employer document
 * id — firestore.rules `isEmployerAdminOf()` compares them directly, and the
 * employer screens query `where('employerId', '==', user.uid)`. An account
 * with a random uid would sign in, pass the route guard, and then show an
 * empty roster and an empty dashboard. So the account is created with
 * uid = qa-funpay-demo-employer, the id seed-qa-employer.js already used.
 * That binds it to the QA fixture company and to nothing else: it can only
 * ever read the QA employees who registered with code FUNQA1.
 *
 * THE OPS ACCOUNT IS NOT A FIXTURE
 * --------------------------------
 * `ops` is a real production role. It reads every borrower's file and it can
 * approve employers for real. There is no scoped-down version of it — the
 * console is the console. This account is therefore created like any other
 * privileged credential: handed to a person, never published. The team portal
 * at alfa.funpay.mx has no authentication of its own; nothing from this
 * script belongs on that page.
 *
 * PASSWORDS COME FROM THE ENVIRONMENT, NEVER FROM HERE
 * ----------------------------------------------------
 * A generated password would have to be printed to be usable, and an Actions
 * log is readable by everyone with repo access, forever. So the caller
 * supplies both passwords as secrets and this script prints only emails,
 * uids and roles.
 *
 * USAGE
 *   SA_KEY_PATH=/tmp/sa-key.json \
 *   QA_EMPLOYER_PASSWORD=… QA_OPS_PASSWORD=… \
 *   node scripts/seed-portal-test-accounts.js [--dry-run]
 *
 * Re-running is safe and idempotent. Unlike bootstrap-test-accounts.js this
 * one DOES reset the password of an account that already exists: these two
 * are disposable QA credentials whose whole purpose is that the caller knows
 * them, and the caller just supplied the value it should be.
 */

const admin = require('firebase-admin');

const dryRun = process.argv.slice(2).includes('--dry-run');
const SA_KEY_PATH = process.env.SA_KEY_PATH || '/tmp/sa-key.json';
const AUDIT_LOG_COLLECTION = 'audit_log'; // functions/src/utils/auditLog.ts
const QA_EMPLOYER_ID = 'qa-funpay-demo-employer'; // scripts/seed-qa-employer.js

const ACCOUNTS = [
  {
    key: 'employer',
    uid: QA_EMPLOYER_ID,
    email: 'qa-empleador@demo-diagnostic.funpay.mx',
    displayName: 'FunPay QA — empleador de prueba',
    role: 'employer_admin',
    password: process.env.QA_EMPLOYER_PASSWORD,
  },
  {
    key: 'ops',
    uid: null, // no pinning: ops is not scoped to a document
    email: 'qa-ops@demo-diagnostic.funpay.mx',
    displayName: 'FunPay QA — operaciones de prueba',
    role: 'ops',
    password: process.env.QA_OPS_PASSWORD,
  },
];

let serviceAccount;
try {
  serviceAccount = require(SA_KEY_PATH);
} catch {
  console.error(`ERROR: service account key not found at ${SA_KEY_PATH}`);
  process.exit(1);
}

for (const a of ACCOUNTS) {
  if (!a.password || a.password.length < 12) {
    console.error(`ERROR: password for the ${a.key} account is missing or under 12 characters.`);
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const auth = admin.auth();
  const db = admin.firestore();
  const operator = process.env.OPERATOR || process.env.USER || 'unknown-operator';

  // The employer account is worthless without the company it administers, and
  // creating that company is seed-qa-employer.js's job, not this one's.
  const employer = await db.collection('employers').doc(QA_EMPLOYER_ID).get();
  if (!employer.exists) {
    console.error(
      `ERROR: employers/${QA_EMPLOYER_ID} does not exist. Run the ` +
        '"Seed QA employer (production)" workflow first.'
    );
    process.exit(1);
  }
  console.log(`[OK] employers/${QA_EMPLOYER_ID} — ${employer.data().companyName}`);

  for (const acct of ACCOUNTS) {
    let user = null;
    try {
      user = await auth.getUserByEmail(acct.email);
    } catch {
      /* not created yet */
    }

    if (user && acct.uid && user.uid !== acct.uid) {
      console.error(
        `ERROR: ${acct.email} exists as uid=${user.uid} but must be ${acct.uid} for the ` +
          'employer screens to see their own data. Delete that account and re-run.'
      );
      process.exit(1);
    }

    if (dryRun) {
      console.log(
        `[DRY-RUN] would ${user ? 'reset the password of' : 'create'} ${acct.email} ` +
          `(uid=${acct.uid || 'auto'}) with role=${acct.role}`
      );
      continue;
    }

    if (user) {
      await auth.updateUser(user.uid, { password: acct.password, emailVerified: true });
      console.log(`[RESET]   ${acct.email} (uid=${user.uid}) — password set to the supplied value`);
    } else {
      user = await auth.createUser({
        ...(acct.uid ? { uid: acct.uid } : {}),
        email: acct.email,
        password: acct.password,
        displayName: acct.displayName,
        emailVerified: true,
      });
      console.log(`[CREATED] ${acct.email} (uid=${user.uid})`);
    }

    const previousRole = user.customClaims?.role ?? null;

    // setCustomUserClaims REPLACES the claims object — see the note at
    // functions/src/index.ts:1728. Role alone is what every other call site
    // writes, and what firestore.rules reads.
    await auth.setCustomUserClaims(user.uid, { role: acct.role });

    await db
      .collection('users')
      .doc(user.uid)
      .set(
        {
          email: acct.email,
          role: acct.role,
          displayName: acct.displayName,
          isQaFixture: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await db.collection(AUDIT_LOG_COLLECTION).add({
      action: 'admin.seedPortalTestAccount',
      actorUid: `script:seed-portal-test-accounts:${operator}`,
      actorRole: 'operator',
      actorEmail: null,
      targetCollection: 'users',
      targetId: user.uid,
      before: { role: previousRole },
      after: { role: acct.role },
      meta: {
        entityType: 'user',
        source: 'scripts/seed-portal-test-accounts.js',
        note: 'QA sign-in account for the team portal. Credentials handed over out of band.',
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[OK]      ${acct.email} role=${acct.role} claim + users/${user.uid} synced`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing was created, no claim was changed.');
    return;
  }

  console.log('\nPasswords are the ones the caller supplied — not printed here on purpose.');
  console.log('A custom claim reaches the ID token on the NEXT sign-in, so the first');
  console.log('login after this run is the one that picks up the role.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
