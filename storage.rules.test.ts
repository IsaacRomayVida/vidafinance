/**
 * Storage Security Rules Unit Tests
 *
 * Companion to firestore.rules.test.ts. storage.rules is the OTHER half of the
 * client-facing perimeter — it guards employer KYC documents, borrowers'
 * identity documents, signed loan contracts and payroll CSVs — and until this
 * file it had no test at all. That is how `onboarding/employer_signup/*` came to
 * grant an unauthenticated write and stay that way.
 *
 * Run against the Firebase emulator:
 *   firebase emulators:exec --only storage "npx jest storage.rules.test"
 *
 * Or, alongside the Firestore rules suite: npm run test:rules
 */

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import * as path from 'path';

let testEnv: RulesTestEnvironment;

// `firebase emulators:exec` exports FIREBASE_STORAGE_EMULATOR_HOST for the child
// process. Honour it so the suite follows the emulator onto a non-default port;
// fall back to the firebase.json default when running against a manually
// started emulator.
const [emulatorHost, emulatorPort] = (
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || 'localhost:9199'
).split(':');

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const PDF_META = { contentType: 'application/pdf' };

// >= 20 characters, which is all the old rule ever asked of it.
const SESSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const OPS = { role: 'ops' };
const ADMIN = { role: 'admin' };
const EMPLOYEE = { role: 'employee' };
// Every setCustomUserClaims call site in the repo writes `{ role }` only, so no
// real employer_admin carries an employerId claim. The rules' isEmployerAdminOf()
// requires one, which is why the employer paths below are asserted as denied
// rather than allowed — see getContractDownloadUrl.ts's comment on the same gap.
const EMPLOYER_ADMIN = { role: 'employer_admin' };

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'vida-finance-test',
    storage: {
      rules: readFileSync(path.resolve(__dirname, 'storage.rules'), 'utf8'),
      host: emulatorHost,
      port: Number(emulatorPort),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearStorage();
});

/** Puts an object in place with rules disabled, so `read`/overwrite can be tested. */
async function seedObject(objectPath: string): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), objectPath), PDF, PDF_META);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// onboarding/employer_signup/** — the anonymous-write hole
//
// The rule carried no request.auth term at all, so an anonymous caller who knew
// the bucket name (it ships in the web bundle) could deposit unlimited 10 MB
// PDFs and images into this project's bucket: storage and egress billed to VIDA,
// attacker-controlled files served from a firebasestorage URL for this project,
// and ops opening them from the console as though they were employer KYC
// documents. The ">= 20 chars of entropy" the rule checked was entropy the
// ATTACKER chose.
// ─────────────────────────────────────────────────────────────────────────────
describe('onboarding/employer_signup', () => {
  const objectPath = `onboarding/employer_signup/${SESSION_ID}/rfc.pdf`;

  it('denies an anonymous write', async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(storage, objectPath), PDF, PDF_META));
  });

  it('denies an anonymous write however long the sessionId is', async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(ref(storage, `onboarding/employer_signup/${'z'.repeat(64)}/id.pdf`), PDF, PDF_META)
    );
  });

  it('denies a signed-in borrower a write too', async () => {
    const storage = testEnv.authenticatedContext('employee-1', EMPLOYEE).storage();
    await assertFails(uploadBytes(ref(storage, objectPath), PDF, PDF_META));
  });

  it('denies an anonymous overwrite of an object already there', async () => {
    await seedObject(objectPath);
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(storage, objectPath), PDF, PDF_META));
  });

  it('denies an anonymous delete of an object already there', async () => {
    await seedObject(objectPath);
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(deleteObject(ref(storage, objectPath)));
  });

  // Whatever was deposited while the rule was open still has to be reachable by
  // the people who would clean it up.
  it('still lets ops read what is already there', async () => {
    await seedObject(objectPath);
    const storage = testEnv.authenticatedContext('ops-1', OPS).storage();
    await assertSucceeds(getBytes(ref(storage, objectPath)));
  });

  it('denies an anonymous read', async () => {
    await seedObject(objectPath);
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(storage, objectPath)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The neighbouring paths, pinned so closing the hole above is not mistaken for
// closing the flow that actually uploads employer documents.
// ─────────────────────────────────────────────────────────────────────────────
describe('onboarding/employer_docs/{uid}', () => {
  it('lets an employer write under their own uid', async () => {
    const storage = testEnv.authenticatedContext('employer-a', EMPLOYER_ADMIN).storage();
    await assertSucceeds(
      uploadBytes(ref(storage, 'onboarding/employer_docs/employer-a/docRFC'), PDF, PDF_META)
    );
  });

  it('denies an employer writing under another employer uid', async () => {
    const storage = testEnv.authenticatedContext('employer-b', EMPLOYER_ADMIN).storage();
    await assertFails(
      uploadBytes(ref(storage, 'onboarding/employer_docs/employer-a/docRFC'), PDF, PDF_META)
    );
  });

  it('denies an anonymous write', async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(ref(storage, 'onboarding/employer_docs/employer-a/docRFC'), PDF, PDF_META)
    );
  });

  it('denies one employer reading another employer document', async () => {
    await seedObject('onboarding/employer_docs/employer-a/docRFC');
    const storage = testEnv.authenticatedContext('employer-b', EMPLOYER_ADMIN).storage();
    await assertFails(getBytes(ref(storage, 'onboarding/employer_docs/employer-a/docRFC')));
  });

  it('lets ops read it', async () => {
    await seedObject('onboarding/employer_docs/employer-a/docRFC');
    const storage = testEnv.authenticatedContext('ops-1', OPS).storage();
    await assertSucceeds(getBytes(ref(storage, 'onboarding/employer_docs/employer-a/docRFC')));
  });
});

describe('kyc/{employeeUid}', () => {
  it('lets a borrower upload their own identity document', async () => {
    const storage = testEnv.authenticatedContext('employee-1', EMPLOYEE).storage();
    await assertSucceeds(uploadBytes(ref(storage, 'kyc/employee-1/ine.pdf'), PDF, PDF_META));
  });

  it('denies a borrower uploading under another borrower uid', async () => {
    const storage = testEnv.authenticatedContext('employee-2', EMPLOYEE).storage();
    await assertFails(uploadBytes(ref(storage, 'kyc/employee-1/ine.pdf'), PDF, PDF_META));
  });

  // The core isolation on this collection: an employer_admin has no business
  // reading their staff's identity documents out of Storage.
  it('denies an employer_admin reading a borrower identity document', async () => {
    await seedObject('kyc/employee-1/ine.pdf');
    const storage = testEnv.authenticatedContext('employer-a', EMPLOYER_ADMIN).storage();
    await assertFails(getBytes(ref(storage, 'kyc/employee-1/ine.pdf')));
  });

  it('denies another borrower reading it', async () => {
    await seedObject('kyc/employee-1/ine.pdf');
    const storage = testEnv.authenticatedContext('employee-2', EMPLOYEE).storage();
    await assertFails(getBytes(ref(storage, 'kyc/employee-1/ine.pdf')));
  });

  it('lets the owner and ops read it', async () => {
    await seedObject('kyc/employee-1/ine.pdf');
    await assertSucceeds(
      getBytes(ref(testEnv.authenticatedContext('employee-1', EMPLOYEE).storage(), 'kyc/employee-1/ine.pdf'))
    );
    await assertSucceeds(
      getBytes(ref(testEnv.authenticatedContext('ops-1', OPS).storage(), 'kyc/employee-1/ine.pdf'))
    );
  });
});

describe('loans/{loanId} — signed contracts', () => {
  it('denies every client a write, ops included', async () => {
    await assertFails(
      uploadBytes(
        ref(testEnv.authenticatedContext('ops-1', ADMIN).storage(), 'loans/loan-1/contrato_x.pdf'),
        PDF,
        PDF_META
      )
    );
  });

  it('denies an unrelated borrower a read', async () => {
    await seedObject('loans/loan-1/contrato_x.pdf');
    const storage = testEnv.authenticatedContext('employee-9', EMPLOYEE).storage();
    await assertFails(getBytes(ref(storage, 'loans/loan-1/contrato_x.pdf')));
  });
});

describe('default deny', () => {
  it('denies an unlisted path to an authenticated caller', async () => {
    const storage = testEnv.authenticatedContext('employee-1', EMPLOYEE).storage();
    await assertFails(uploadBytes(ref(storage, 'anything/else.pdf'), PDF, PDF_META));
  });

  it('denies an unlisted path to an anonymous caller', async () => {
    const storage = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(storage, 'anything/else.pdf'), PDF, PDF_META));
  });
});
