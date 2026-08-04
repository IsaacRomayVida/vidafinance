/**
 * Firestore Security Rules Unit Tests
 *
 * Run against the Firebase emulator:
 *   firebase emulators:start --only firestore &
 *   npx jest firestore.rules.test
 *
 * Or via: npm run test:rules
 */

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
} from 'firebase/firestore';
import * as path from 'path';

let testEnv: RulesTestEnvironment;

// `firebase emulators:exec` exports FIRESTORE_EMULATOR_HOST for the child process.
// Honour it so the suite follows the emulator onto a non-default port; fall back to
// the firebase.json default (localhost:8080) when running against a manually
// started emulator.
const [emulatorHost, emulatorPort] = (process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080').split(':');

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'vida-finance-test',
    firestore: {
      rules: readFileSync(path.resolve(__dirname, 'firestore.rules'), 'utf8'),
      host: emulatorHost,
      port: Number(emulatorPort),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedLoan(loanId: string, employeeId: string, employerId: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `loans/${loanId}`), {
      employeeId,
      employerId,
      amount: 1000,
      fee: 300,
      total: 1300,
      status: 'pending',
    });
  });
}

async function seedEmployer(employerId: string, data: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `employers/${employerId}`), {
      name: 'Test Company',
      status: 'active',
      ...data,
    });
  });
}

async function seedEmployee(employeeId: string, employerId: string, data: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `employees/${employeeId}`), {
      employerId,
      name: 'Test Employee',
      ...data,
    });
  });
}

async function seedAuditLog(logId: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `audit_log/${logId}`), {
      action: 'loan.requested',
      actorUid: 'employee1',
    });
  });
}

// ── loans collection ─────────────────────────────────────────────────────────

describe('loans collection', () => {
  it(`employee cannot read another employee's loan`, async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee2', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it('employee can read their own loan', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it(`employer can read their own employee's loan`, async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it(`employer cannot read another employer's loan`, async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employer2', { role: 'employer_admin' });
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it('ops user can read all loans', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it('anonymous user is denied on loans', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1')));
  });

  it('loan create is always denied from client SDK', async () => {
    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'loans/new-loan'), {
        employeeId: 'employee1',
        employerId: 'employer1',
        amount: 1000,
        status: 'pending',
      })
    );
  });

  it('loan create is denied even for admins from client SDK', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'loans/admin-created-loan'), {
        employeeId: 'employee1',
        amount: 1000,
        status: 'pending',
      })
    );
  });

  it('loan update is always denied from client SDK', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    // Even the employer who owns the loan cannot update it from client SDK
    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(updateDoc(doc(ctx.firestore(), 'loans/loan1'), { status: 'approved' }));
  });

  it('loan delete is always denied', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(deleteDoc(doc(ctx.firestore(), 'loans/loan1')));
  });
});

// ── loans/{loanId}/underwritingDetail subcollection (E5c) ─────────────────────
// The Stage 3 auto-approve condition breakdown — each condition carries the
// applicant's actual bureau score, LTI, RiskSeal fraud score and ML default
// probability alongside the bound it was tested against. This is a
// subcollection, deliberately NOT a field on the loan document above, so it
// does not inherit that document's `isOwner`/`isEmployerAdminOf` read access —
// the whole point is that the borrower and the employer admin who CAN read
// `loans/{loanId}` must NOT be able to read this.

async function seedUnderwritingDetail(loanId: string, data: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `loans/${loanId}/underwritingDetail/detail`), {
      decision: 'approved',
      allPass: true,
      conditions: [{ id: 3, name: 'bureau_score', pass: true, value: 650, required: '> 600', source: 'read' }],
      ...data,
    });
  });
}

describe('loans/{loanId}/underwritingDetail subcollection', () => {
  it(`the loan's own employee cannot read the underwriting breakdown`, async () => {
    await seedLoan('loan1', 'employee1', 'employer1');
    await seedUnderwritingDetail('loan1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1/underwritingDetail/detail')));
  });

  it(`the loan's employer admin cannot read the underwriting breakdown`, async () => {
    await seedLoan('loan1', 'employee1', 'employer1');
    await seedUnderwritingDetail('loan1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1/underwritingDetail/detail')));
  });

  it('ops user can read the underwriting breakdown', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');
    await seedUnderwritingDetail('loan1');

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'loans/loan1/underwritingDetail/detail')));
  });

  it('anonymous user is denied on the underwriting breakdown', async () => {
    await seedLoan('loan1', 'employee1', 'employer1');
    await seedUnderwritingDetail('loan1');

    const ctx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), 'loans/loan1/underwritingDetail/detail')));
  });

  it('write is always denied from client SDK, even for ops', async () => {
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'loans/loan1/underwritingDetail/detail'), { decision: 'approved' })
    );
  });
});

// ── employers collection ──────────────────────────────────────────────────────

describe('employers collection', () => {
  it('employer can read their own record', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employers/employer1')));
  });

  it('user without claims can read their own employer record', async () => {
    await seedEmployer('employer1');

    // No custom claims — simulates user before claims propagate
    const ctx = testEnv.authenticatedContext('employer1');
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employers/employer1')));
  });

  it(`employer cannot read another employer's record`, async () => {
    await seedEmployer('employer2');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(getDoc(doc(ctx.firestore(), 'employers/employer2')));
  });

  it('ops user can read all employers', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employers/employer1')));
  });

  it('anonymous user is denied on employers', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), 'employers/employer1')));
  });

  it('user can create their own employer record during onboarding', async () => {
    const ctx = testEnv.authenticatedContext('employer1');
    await assertSucceeds(
      setDoc(doc(ctx.firestore(), 'employers/employer1'), { name: 'My Company', status: 'pending_verification' })
    );
  });

  it('user cannot create an employer record for another user', async () => {
    const ctx = testEnv.authenticatedContext('employer1');
    await assertFails(
      setDoc(doc(ctx.firestore(), 'employers/employer2'), { name: 'My Company', status: 'pending' })
    );
  });

  it('admin can create an employer', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(
      setDoc(doc(ctx.firestore(), 'employers/new-employer'), { name: 'New Company', status: 'pending' })
    );
  });

  it('admin can update employer status', async () => {
    await seedEmployer('employer1', { status: 'pending' });

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(updateDoc(doc(ctx.firestore(), 'employers/employer1'), { status: 'active' }));
  });

  it('employer can update only allowed contact fields', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertSucceeds(
      updateDoc(doc(ctx.firestore(), 'employers/employer1'), {
        contactName: 'Jane Doe',
        contactEmail: 'jane@company.com',
      })
    );
  });

  it('employer cannot update restricted fields', async () => {
    // Seed with status 'pending' so updating to 'active' is a real field change,
    // ensuring affectedKeys() is non-empty and the hasOnly() check is actually exercised.
    await seedEmployer('employer1', { status: 'pending' });

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    // 'status' is not in the allowed-update list for employers
    await assertFails(updateDoc(doc(ctx.firestore(), 'employers/employer1'), { status: 'active' }));
  });

  // ── audit AUDIT_EMPLOYER_PATH.md E2 / E6 — the fields real employer/employee
  // surfaces actually write, all outside the update whitelist. E2's write moved
  // to onEmployeeDocCreated (Admin SDK); E6a/b/c moved to callables
  // (submitEmployerDocs / submitPayrollDeductionSetup / ensureEmployerCode).
  // These assertions are the regression guard: if a client write to any of
  // these fields is ever reintroduced, it must stay denied here, not silently
  // pass because the whitelist was widened to paper over it.

  describe('client writes the rules deny (E2/E6 regression guard)', () => {
    it('E2: a newly-registered employee cannot increment employers/{id}.totalEmployees', async () => {
      await seedEmployer('employer1', { totalEmployees: 0 });

      // The caller is the new employee (Onboarding.tsx createEmployeeAccount),
      // not the employer admin, and holds no employer_admin claim.
      const ctx = testEnv.authenticatedContext('newEmployee1', { role: 'employee' });
      await assertFails(
        updateDoc(doc(ctx.firestore(), 'employers/employer1'), { totalEmployees: 1 })
      );
    });

    it('E6a: employer cannot self-update KYC document URLs (DocUploadBanner payload)', async () => {
      await seedEmployer('employer1', { docRFC: null, docId: null, docAddress: null });

      const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
      await assertFails(
        updateDoc(doc(ctx.firestore(), 'employers/employer1'), {
          docRFC: 'https://firebasestorage.googleapis.com/v0/b/x/o/rfc.pdf',
          docId: 'https://firebasestorage.googleapis.com/v0/b/x/o/id.pdf',
          docAddress: 'https://firebasestorage.googleapis.com/v0/b/x/o/addr.pdf',
        })
      );
    });

    it('E6b: employer cannot self-update Part B payroll setup (sampleCurps/partBStatus)', async () => {
      await seedEmployer('employer1');

      const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
      await assertFails(
        updateDoc(doc(ctx.firestore(), 'employers/employer1'), {
          sampleCurps: ['AAAA000000HDFAAA01', 'BBBB000000HDFBBB02', 'CCCC000000HDFCCC03'],
          partBStatus: 'pending',
        })
      );
    });

    it('E6c: employer cannot self-backfill employerCode via update', async () => {
      await seedEmployer('employer1');

      const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
      await assertFails(
        updateDoc(doc(ctx.firestore(), 'employers/employer1'), { employerCode: 'ABC123' })
      );
    });

    // Control: proves the harness above is sound — a whitelisted field on the
    // same document, from the same caller, in the same shape, still succeeds.
    it('control: the whitelisted contactName write still succeeds for the same caller', async () => {
      await seedEmployer('employer1');

      const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
      await assertSucceeds(
        updateDoc(doc(ctx.firestore(), 'employers/employer1'), { contactName: 'Jane Doe' })
      );
    });
  });

  it('employer delete is always denied', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(deleteDoc(doc(ctx.firestore(), 'employers/employer1')));
  });

  // ── P1-2: the employers collection must not be listable ────────────────────
  // `allow list: if true` returned every employer document in full — apiKeyHash,
  // rfc, bankClabe, email, employerCode, mlScore, riskTier, llmAnalysis — to any
  // caller. The onboarding employerCode lookup that motivated it now goes
  // through the lookupEmployerByCode CF.

  describe('employers list is not a public dump (P1-2)', () => {
    async function seedSensitiveEmployer() {
      await seedEmployer('employer1', {
        companyName: 'Acme SA de CV',
        employerCode: 'ACME01',
        apiKeyHash: 'sha256-of-the-live-api-key',
        rfc: 'AAA010101AAA',
        bankClabe: '012345678901234567',
        email: 'finance@acme.mx',
        mlScore: 0.91,
        riskTier: 'A',
        llmAnalysis: 'internal underwriting narrative',
      });
    }

    it('anonymous user cannot list the employers collection', async () => {
      await seedSensitiveEmployer();

      const ctx = testEnv.unauthenticatedContext();
      await assertFails(getDocs(collection(ctx.firestore(), 'employers')));
    });

    it('anonymous user cannot query employers by employerCode', async () => {
      await seedSensitiveEmployer();

      // The exact query Onboarding.tsx used to run before the lookup moved
      // server-side. It returned the whole matching document.
      const ctx = testEnv.unauthenticatedContext();
      await assertFails(
        getDocs(query(collection(ctx.firestore(), 'employers'), where('employerCode', '==', 'ACME01')))
      );
    });

    it('an authenticated employee cannot list the employers collection', async () => {
      await seedSensitiveEmployer();

      const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
      await assertFails(getDocs(collection(ctx.firestore(), 'employers')));
    });

    it('an employer_admin cannot list other employers', async () => {
      await seedSensitiveEmployer();

      const ctx = testEnv.authenticatedContext('employer2', { role: 'employer_admin' });
      await assertFails(getDocs(collection(ctx.firestore(), 'employers')));
    });

    it('ops can still list employers (admin console)', async () => {
      await seedSensitiveEmployer();

      const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
      await assertSucceeds(getDocs(collection(ctx.firestore(), 'employers')));
    });

    it('admin can still list employers (admin console)', async () => {
      await seedSensitiveEmployer();

      const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
      await assertSucceeds(getDocs(collection(ctx.firestore(), 'employers')));
    });
  });

  // ── P1-3: self-created employer docs cannot claim a privileged state ───────
  // onEmployerDocCreated grants the employer_admin claim only for an employer
  // that is already approved/active at creation. These rules are the other half
  // of that gate: a self-signup may only create a 'pending_verification' doc, so
  // it can never mint the claim for itself.

  describe('employer self-signup cannot escalate (P1-3)', () => {
    it(`user cannot self-create an employer with status 'active'`, async () => {
      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
          name: 'My Company',
          status: 'active',
        })
      );
    });

    it(`user cannot self-create an employer with status 'approved'`, async () => {
      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
          name: 'My Company',
          status: 'approved',
        })
      );
    });

    it('user cannot self-create an employer carrying an apiKeyHash', async () => {
      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
          name: 'My Company',
          status: 'pending_verification',
          apiKeyHash: 'attacker-chosen-hash',
        })
      );
    });

    it('user cannot self-create an employer carrying a creditLimit', async () => {
      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
          name: 'My Company',
          status: 'pending_verification',
          creditLimit: 5000000,
        })
      );
    });

    it('user cannot self-create an employer carrying a riskTier', async () => {
      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
          name: 'My Company',
          status: 'pending_verification',
          riskTier: 'A',
        })
      );
    });

    // ADR-009: `maxActiveSlots` was already blocked here, but the fields that
    // FEED it were not. An employer that self-created with `tier: 1` and a
    // pre-loaded `cleanPayrollCyclesSinceReview` would walk its first
    // due-diligence review straight into a credited slot increment. Blocking
    // the cap while leaving its inputs writable is not a cap.
    const SLOT_LEDGER_FIELDS: Array<[string, unknown]> = [
      ['maxActiveSlots', 500],
      ['maxActiveSlotsSource', 'ops_override'],
      ['tier', 1],
      ['cleanPayrollCycles', 99],
      ['cleanPayrollCyclesSinceReview', 99],
      ['employerScore', 100],
      ['dueDiligenceResult', { pass: true, tier: 1, score: 100 }],
    ];

    for (const [field, value] of SLOT_LEDGER_FIELDS) {
      it(`user cannot self-create an employer carrying a ${field}`, async () => {
        const ctx = testEnv.authenticatedContext('attacker1');
        await assertFails(
          setDoc(doc(ctx.firestore(), 'employers/attacker1'), {
            name: 'My Company',
            status: 'pending_verification',
            [field]: value,
          })
        );
      });
    }

    it('the real onboarding shape is still accepted', async () => {
      // Mirrors the payload Onboarding.tsx writes at createEmployerAccount.
      const ctx = testEnv.authenticatedContext('employer9');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employers/employer9'), {
          name: 'Ana Lopez',
          companyName: 'Nueva SA',
          email: 'ana@nueva.mx',
          phone: '+525512345678',
          rfc: 'NUE010101AAA',
          state: 'CDMX',
          industry: 'retail',
          employeeCount: '11-50',
          payFrequency: 'quincenal',
          payrollSystem: 'other',
          usesDispersora: false,
          bankClabe: '012345678901234567',
          employerCode: 'NUE123',
          employeeCurps: [],
          dispersoraName: null,
          status: 'pending_verification',
          docUrls: {},
          docRFC: null,
          docId: null,
          docAddress: null,
          totalEmployees: 0,
          activeLoans: 0,
          totalDisbursed: 0,
        })
      );
    });

    it('admin can still create an employer in any state', async () => {
      const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employers/new-employer'), {
          name: 'New Company',
          status: 'active',
          apiKeyHash: 'issued-by-approveEmployer',
        })
      );
    });
  });
});

// ── employees collection ──────────────────────────────────────────────────────

describe('employees collection', () => {
  it('employee can read their own record', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employees/employee1')));
  });

  it(`employee cannot read another employee's record`, async () => {
    await seedEmployee('employee2', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'employees/employee2')));
  });

  it('employer can read their own employee', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employer1');
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employees/employee1')));
  });

  it('ops can read any employee', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'employees/employee1')));
  });

  it('employee can update only allowed personal fields', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertSucceeds(
      updateDoc(doc(ctx.firestore(), 'employees/employee1'), {
        phone: '+521234567890',
        bankClabe: '123456789012345678',
      })
    );
  });

  it('employee cannot update credit limit or employerId', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(
      updateDoc(doc(ctx.firestore(), 'employees/employee1'), { creditLimit: 99999 })
    );
  });

  // #385 tightened /loans and /employers to `allow delete: if false` but left
  // /employees on `if isOps()`, even though an employee document is exactly what
  // a loan's employeeId points at. Deleting one orphans its loans and writes no
  // audit record, since audit_log has no client writer.
  it('employee delete is always denied, even for ops', async () => {
    await seedEmployee('employee1', 'employer1');

    const ops = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(deleteDoc(doc(ops.firestore(), 'employees/employee1')));

    const owner = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(deleteDoc(doc(owner.firestore(), 'employees/employee1')));
  });

  // ── P1-1: the credit line cannot be self-assigned at registration ──────────
  // Onboarding.tsx used to compute creditLimit/availableCredit on the client and
  // write them into employees/{uid} on create. `allow create: if isOwner(...)`
  // did no field validation, so the user picked their own borrowing ceiling.
  // Both fields are now derived by onEmployeeDocCreated from monthlySalary.

  describe('employee cannot self-assign a credit line (P1-1)', () => {
    // The legitimate onboarding payload, minus anything server-derived.
    const registration = {
      name: 'Test Employee',
      email: 'employee@acme.mx',
      phone: '+525512345678',
      dateOfBirth: '1990-01-15',
      curp: 'TEST900115HDFXXX01',
      gender: 'M',
      rfc: 'TES900115AAA',
      employerId: 'employer1',
      employerName: 'Acme SA de CV',
      employerCode: 'ACME01',
      monthlySalary: 12000,
      payFrequency: 'quincenal',
      employmentTenure: '2y',
      bankClabe: '012345678901234567',
      kycStatus: 'pending_review',
    };

    beforeEach(async () => {
      // The enrolment-rules gate (fix/employee-enrolment-rules) reads the
      // named employer at create time, so these tests need a real one behind
      // 'employer1' now — status 'active' via the seedEmployer default, no
      // curpConfig, so it does not additionally constrain CURP.
      await seedEmployer('employer1');
    });

    it('registration is rejected when it carries a creditLimit', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), {
          ...registration,
          creditLimit: 99999,
        })
      );
    });

    it('registration is rejected when it carries availableCredit', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), {
          ...registration,
          availableCredit: 99999,
        })
      );
    });

    it('registration is rejected when it carries both (the old client payload)', async () => {
      // This is verbatim what Onboarding.tsx wrote before the fix:
      // creditLimit = Math.min(salary * 0.3, 5000), availableCredit = creditLimit.
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), {
          ...registration,
          creditLimit: 3600,
          availableCredit: 3600,
        })
      );
    });

    it('registration is rejected when it carries a riskTier or mlScore', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), {
          ...registration,
          riskTier: 'A',
          mlScore: 0.99,
        })
      );
    });

    it('registration is rejected when it forges salarySource', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), {
          ...registration,
          salarySource: 'employer_verified',
        })
      );
    });

    it('the real onboarding shape is still accepted', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(setDoc(doc(ctx.firestore(), 'employees/employee1'), registration));
    });

    it('a user still cannot register as somebody else', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(setDoc(doc(ctx.firestore(), 'employees/employee2'), registration));
    });
  });

  // ── employee enrolment cannot forge an employerId (fix/employee-enrolment-rules) ──
  // employees/{uid}.employerId is client-chosen. Before this gate, nothing
  // cross-checked it against the named employer's existence, status, or CURP
  // allowlist — anyone who knew (or guessed) an employer's join code could
  // enrol under that employer. These are the write-time counterpart to
  // requestLoan's own curpConfig enforcement (PR #566, money side).

  describe('employee enrolment cannot forge an employerId (VID3 enrolment gate)', () => {
    const registrationFor = (employerId: string, curp: string) => ({
      name: 'Test Employee',
      email: 'employee@acme.mx',
      phone: '+525512345678',
      dateOfBirth: '1990-01-15',
      curp,
      gender: 'M',
      rfc: 'TES900115AAA',
      employerId,
      employerName: 'Acme SA de CV',
      employerCode: 'ACME01',
      monthlySalary: 12000,
      payFrequency: 'quincenal',
      employmentTenure: '2y',
      bankClabe: '012345678901234567',
      kycStatus: 'pending_review',
    });

    it('registration is rejected when the named employer does not exist', async () => {
      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('no-such-employer', 'TEST900115HDFXXX01'))
      );
    });

    it('registration is rejected when the named employer is suspended', async () => {
      await seedEmployer('employerSuspended', { status: 'suspended' });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerSuspended', 'TEST900115HDFXXX01'))
      );
    });

    it('registration is rejected when the named employer is rejected', async () => {
      await seedEmployer('employerRejected', { status: 'rejected' });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerRejected', 'TEST900115HDFXXX01'))
      );
    });

    it(`registration succeeds against an employer still 'pending_verification' (self-serve onboarding, pre-approval)`, async () => {
      await seedEmployer('employerPending', { status: 'pending_verification' });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerPending', 'TEST900115HDFXXX01'))
      );
    });

    it('registration succeeds against an active employer with no curpConfig at all', async () => {
      await seedEmployer('employerNoConfig', { status: 'active' });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerNoConfig', 'TEST900115HDFXXX01'))
      );
    });

    it(`registration succeeds against an employer whose curpConfig.mode is 'open'`, async () => {
      await seedEmployer('employerOpen', {
        status: 'active',
        curpConfig: { mode: 'open', prefixes: ['ZZZZ'] },
      });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerOpen', 'TEST900115HDFXXX01'))
      );
    });

    it(`registration is rejected when curpConfig is an allowlist and the CURP prefix is not on it`, async () => {
      // The forged-employerId attack this gate exists for: the attacker knows
      // a real employer's join code, but that employer has restricted
      // enrolment to a specific CURP prefix set and the attacker's CURP isn't
      // one of them.
      await seedEmployer('employerAllowlisted', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['ACME'] },
      });

      const ctx = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(ctx.firestore(), 'employees/attacker1'), registrationFor('employerAllowlisted', 'ZZZZ900115HDFXXX01'))
      );
    });

    it(`registration succeeds when curpConfig is an allowlist and the CURP prefix matches (case-insensitive)`, async () => {
      await seedEmployer('employerAllowlisted', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['ACME'] },
      });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerAllowlisted', 'acme900115HDFXXX01'))
      );
    });

    // ── a stored allowlist that is not well-formed reads as UNCONFIGURED ──
    // Not as "deny everyone". requestLoan (index.ts,
    // assertBorrowerAdmittedByEmployer, #566) makes exactly this call and says
    // so in the log: an employer entitled to no borrowers at all is not a
    // setting anyone picks on purpose, and until #566 saving it did literally
    // nothing, so an employer may hold that state having never been shown what
    // it meant. Denying here while the money gate admits would take their new
    // hires off the product on the enforcing deploy, silently.

    it('an allowlist with an empty prefix list reads as unconfigured, matching requestLoan — it does not lock the employer out of hiring', async () => {
      await seedEmployer('employerEmptyAllowlist', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: [] },
      });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerEmptyAllowlist', 'TEST900115HDFXXX01'))
      );
    });

    it('an allowlist carrying a prefix of the wrong length reads as unconfigured', async () => {
      // updateEmployerCurpConfig keeps only length-4 entries, so a stored 'AB'
      // predates that filter. Enforcing it verbatim would silently widen the
      // allowlist to every CURP beginning 'AB'.
      await seedEmployer('employerShortPrefix', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['AB'] },
      });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerShortPrefix', 'ZZZZ900115HDFXXX01'))
      );
    });

    it('a 4-character prefix of regex metacharacters cannot widen the allowlist to everyone', async () => {
      // '.*ab' is four characters, so updateEmployerCurpConfig's length filter
      // passes it through, and this file interpolates the list into a match
      // pattern. Read as a regex it admits every CURP in existence — the
      // opposite of an allowlist. It must read as unconfigured instead, which
      // leaves requestLoan as the gate that still refuses this borrower.
      await seedEmployer('employerRegexPrefix', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['.*ab'] },
      });

      const ctx = testEnv.authenticatedContext('attacker1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/attacker1'), registrationFor('employerRegexPrefix', 'ZZZZ900115HDFXXX01'))
      );
    });

    it('a 4-character prefix that is not a valid regex does not collapse evaluation into a blanket deny', async () => {
      // '[[[[' would throw inside matches(), and a rule that errors denies —
      // locking a legitimate employer's whole intake out over a malformed
      // setting. The well-formedness test has to run BEFORE the pattern does.
      await seedEmployer('employerBrokenRegex', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['[[[['] },
      });

      const ctx = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), 'employees/employee1'), registrationFor('employerBrokenRegex', 'TEST900115HDFXXX01'))
      );
    });

    it('a well-formed multi-prefix allowlist is still enforced, and still refuses a non-member', async () => {
      // The leniency above must not degrade into "any allowlist is unconfigured".
      await seedEmployer('employerMultiPrefix', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['ACME', 'GARJ'] },
      });

      const member = testEnv.authenticatedContext('employee1');
      await assertSucceeds(
        setDoc(doc(member.firestore(), 'employees/employee1'), registrationFor('employerMultiPrefix', 'GARJ900115HDFXXX01'))
      );

      const outsider = testEnv.authenticatedContext('attacker1');
      await assertFails(
        setDoc(doc(outsider.firestore(), 'employees/attacker1'), registrationFor('employerMultiPrefix', 'ZZZZ900115HDFXXX01'))
      );
    });

    it('an allowlisted employer still refuses a registration carrying no CURP at all', async () => {
      // The registrant supplies their own document; admitting on a missing
      // field would make the control evadable by omitting one.
      await seedEmployer('employerAllowlisted', {
        status: 'active',
        curpConfig: { mode: 'allowlist', prefixes: ['ACME'] },
      });

      const ctx = testEnv.authenticatedContext('attacker1');
      const { curp: _omitted, ...noCurp } = registrationFor('employerAllowlisted', 'ACME900115HDFXXX01');
      await assertFails(setDoc(doc(ctx.firestore(), 'employees/attacker1'), noCurp));
    });

    it('an existing employee document can still be updated by its owner after the gate ships', async () => {
      // The gate only applies to `create` — a document written before this
      // rule shipped, or one whose employer has since changed status, must
      // still be reachable by the ordinary self-update flow.
      await seedEmployer('employerSuspended', { status: 'suspended' });
      await seedEmployee('employeeExisting', 'employerSuspended', { curp: 'TEST900115HDFXXX01' });

      const ctx = testEnv.authenticatedContext('employeeExisting', { role: 'employee' });
      await assertSucceeds(
        updateDoc(doc(ctx.firestore(), 'employees/employeeExisting'), { phone: '+521111111111' })
      );
    });
  });
});

// ── audit_log collection ──────────────────────────────────────────────────────

describe('audit_log collection', () => {
  it('auditLog write is always denied from client SDK', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'audit_log/log1'), {
        action: 'malicious.write',
        actorUid: 'admin1',
      })
    );
  });

  it('admin can read audit logs', async () => {
    await seedAuditLog('log1');

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'audit_log/log1')));
  });

  it('non-admin cannot read audit logs', async () => {
    await seedAuditLog('log1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'audit_log/log1')));
  });

  // P2-2: role grant/revoke used to be written to `auditLogs`, which had no rule
  // and therefore fell through to deny-all — privilege-escalation history was
  // write-only. Both the new home and the legacy one must be ops-readable.
  it('ops can read a role-grant record', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'audit_log/grant1'), {
        action: 'admin.setRole',
        actorUid: 'admin1',
        targetId: 'victim',
        after: { role: 'admin' },
      });
    });

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'audit_log/grant1')));
  });

  it('ops can read historical records left in the legacy auditLogs collection', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'auditLogs/legacy1'), {
        action: 'admin.setRole',
        performedBy: 'admin1',
        entityId: 'victim',
      });
    });

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'auditLogs/legacy1')));
  });

  it('legacy auditLogs remains non-writable and non-readable by employees', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'auditLogs/legacy1'), { action: 'admin.setRole' });
    });

    const admin = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(admin.firestore(), 'auditLogs/legacy1'), { action: 'malicious.rewrite' })
    );

    const employee = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(employee.firestore(), 'auditLogs/legacy1')));
  });
});

// ── users collection ─────────────────────────────────────────────────────────

describe('users collection', () => {
  async function seedUser(userId: string, data: Record<string, unknown> = {}) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${userId}`), {
        email: 'test@example.com',
        role: 'employee',
        ...data,
      });
    });
  }

  it('user can read their own profile', async () => {
    await seedUser('user1', { role: 'employer_admin' });

    const ctx = testEnv.authenticatedContext('user1', { role: 'employer_admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'users/user1')));
  });

  it('user without claims can read their own profile', async () => {
    await seedUser('user1', { role: 'employer_admin' });

    const ctx = testEnv.authenticatedContext('user1');
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'users/user1')));
  });

  it('user cannot read another user profile', async () => {
    await seedUser('user2');

    const ctx = testEnv.authenticatedContext('user1');
    await assertFails(getDoc(doc(ctx.firestore(), 'users/user2')));
  });

  it('user cannot write to users collection', async () => {
    const ctx = testEnv.authenticatedContext('user1');
    await assertFails(
      setDoc(doc(ctx.firestore(), 'users/user1'), { role: 'admin' })
    );
  });

  it('anonymous user cannot read users', async () => {
    await seedUser('user1');

    const ctx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), 'users/user1')));
  });
});

// ── Anonymous user denied everywhere ─────────────────────────────────────────

describe('unauthenticated user', () => {
  const collections = ['loans', 'employers', 'employees', 'users', 'audit_log', 'repayments', 'portfolio_snapshots'];

  it.each(collections)('is denied on %s collection', async (col) => {
    const ctx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(ctx.firestore(), `${col}/some-doc`)));
  });

  it('cannot write to any collection', async () => {
    const ctx = testEnv.unauthenticatedContext();
    await assertFails(
      setDoc(doc(ctx.firestore(), 'loans/anon-loan'), { amount: 1000 })
    );
    await assertFails(
      setDoc(doc(ctx.firestore(), 'employers/anon-emp'), { name: 'Anon Corp' })
    );
    await assertFails(
      setDoc(doc(ctx.firestore(), 'audit_log/anon-log'), { action: 'test' })
    );
  });
});

// ── Internal queues — deny all ────────────────────────────────────────────────

describe('internal queue collections', () => {
  it('disbursement_queue is denied for all clients including admins', async () => {
    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(adminCtx.firestore(), 'disbursement_queue/job1')));
    await assertFails(
      setDoc(doc(adminCtx.firestore(), 'disbursement_queue/job1'), { loanId: 'loan1' })
    );
  });

  it('notification_queue is denied for all clients', async () => {
    const opsCtx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertFails(getDoc(doc(opsCtx.firestore(), 'notification_queue/job1')));
  });
});

// ── metamap_shadow_log — deny all ───────────────────────────────────────────

describe('metamap_shadow_log collection', () => {
  it('admin cannot read metamap_shadow_log', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'metamap_shadow_log/ver1'), {
        verificationId: 'ver1', loanId: 'loan1', status: 'verified',
      });
    });

    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(adminCtx.firestore(), 'metamap_shadow_log/ver1')));
  });

  it('admin cannot write to metamap_shadow_log', async () => {
    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(adminCtx.firestore(), 'metamap_shadow_log/ver1'), {
        verificationId: 'ver1', loanId: 'loan1',
      })
    );
  });

  it('unauthenticated user cannot access metamap_shadow_log', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'metamap_shadow_log/ver1'), {
        verificationId: 'ver1', loanId: 'loan1', status: 'verified',
      });
    });

    const anonCtx = testEnv.unauthenticatedContext();
    await assertFails(getDoc(doc(anonCtx.firestore(), 'metamap_shadow_log/ver1')));
  });
});

// ── VID3-664 core isolation tests ─────────────────────────────────────────────
// These five tests enshrine the isolation invariants the rule rewrite exists
// to protect. If any of these regress, employee PII (CURP/RFC/bank/salary)
// leaks across tenants. Keep passing.

describe('VID3-664 core isolation', () => {
  it('(1) employee A cannot read employee B in the same employer', async () => {
    await seedEmployee('employeeA', 'employer1', { curp: 'AAAA000000HDFAAA01', monthlySalary: 10000 });
    await seedEmployee('employeeB', 'employer1', { curp: 'BBBB000000HDFBBB02', monthlySalary: 20000 });

    const ctx = testEnv.authenticatedContext('employeeA', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'employees/employeeB')));
  });

  it('(2) employee A cannot read employee C in a different employer', async () => {
    await seedEmployee('employeeA', 'employer1');
    await seedEmployee('employeeC', 'employer2', { curp: 'CCCC000000HDFCCC03', bankClabe: '012345678901234567' });

    const ctx = testEnv.authenticatedContext('employeeA', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'employees/employeeC')));
  });

  it('(3) employer admin A can read their own employees but not employer B employees', async () => {
    await seedEmployee('employeeA', 'employer1');
    await seedEmployee('employeeB', 'employer2');

    const employerAdminA = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertSucceeds(getDoc(doc(employerAdminA.firestore(), 'employees/employeeA')));
    await assertFails(getDoc(doc(employerAdminA.firestore(), 'employees/employeeB')));
  });

  it('(4) ops can read any employee', async () => {
    await seedEmployee('employeeA', 'employer1');
    await seedEmployee('employeeB', 'employer2');

    const opsCtx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(opsCtx.firestore(), 'employees/employeeA')));
    await assertSucceeds(getDoc(doc(opsCtx.firestore(), 'employees/employeeB')));
  });

  it('(5) employee cannot write to their own loan doc from client SDK', async () => {
    await seedLoan('loan1', 'employeeA', 'employer1');

    const ctx = testEnv.authenticatedContext('employeeA', { role: 'employee' });
    // create
    await assertFails(
      setDoc(doc(ctx.firestore(), 'loans/loan-new'), {
        employeeId: 'employeeA', employerId: 'employer1', amount: 1000, status: 'pending',
      })
    );
    // update
    await assertFails(updateDoc(doc(ctx.firestore(), 'loans/loan1'), { status: 'paid' }));
  });
});

// ── invites collection — deny all client access (VID3-672) ───────────────────

describe('invites collection', () => {
  it('no client can read invites — Admin SDK only', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'invites/invite1'), {
        employerId: 'employer1', tokenHash: 'abc', status: 'pending',
      });
    });

    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(adminCtx.firestore(), 'invites/invite1')));

    const employerCtx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(getDoc(doc(employerCtx.firestore(), 'invites/invite1')));
  });

  it('no client can write invites — Admin SDK only', async () => {
    const employerCtx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(
      setDoc(doc(employerCtx.firestore(), 'invites/invite-new'), {
        employerId: 'employer1', tokenHash: 'x', status: 'pending',
      })
    );
  });
});

// ── webhookEvents — deny all client access (VID3-657) ────────────────────────

describe('webhookEvents collection', () => {
  it('admin cannot read webhookEvents from client SDK', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'webhookEvents/ev1'), {
        provider: 'metamap', signatureValid: true,
      });
    });

    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(adminCtx.firestore(), 'webhookEvents/ev1')));
  });

  it('no client can write webhookEvents', async () => {
    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(adminCtx.firestore(), 'webhookEvents/ev-new'), { provider: 'metamap' })
    );
  });
});

// ── VID3-710 additional coverage ─────────────────────────────────────────────
// Fills the remaining gaps in the VID3-646 isolation matrix: employer_admin
// write isolation, field-level update whitelist on employees, admin read on
// users, rate-limit collection lockdown, and the default-deny fallback.

describe('employees — write isolation (VID3-710)', () => {
  it('employer_admin cannot update an employee in their own employer (Admin SDK only)', async () => {
    await seedEmployee('employeeA', 'employer1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(
      updateDoc(doc(ctx.firestore(), 'employees/employeeA'), { phone: '+521111111111' })
    );
  });

  it('employer_admin cannot write to /employers/{id}/employees subcollection (Admin SDK only)', async () => {
    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'employers/employer1/employees/emp1'), {
        name: 'Injected', employerId: 'employer1',
      })
    );
  });

  it('employee cannot update their own salary field', async () => {
    await seedEmployee('employee1', 'employer1', { monthlySalary: 10000 });

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(
      updateDoc(doc(ctx.firestore(), 'employees/employee1'), { monthlySalary: 99999 })
    );
  });

  it('employee cannot update their own employerId field', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(
      updateDoc(doc(ctx.firestore(), 'employees/employee1'), { employerId: 'employer2' })
    );
  });

  it('ops can update employee fields (manual correction path)', async () => {
    await seedEmployee('employee1', 'employer1');

    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(
      updateDoc(doc(ctx.firestore(), 'employees/employee1'), { creditLimit: 5000 })
    );
  });
});

describe('users — admin read (VID3-710)', () => {
  it('admin can read any user profile', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users/userX'), {
        email: 'x@example.com', role: 'employee',
      });
    });

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'users/userX')));
  });
});

describe('rate_limits collection (VID3-710)', () => {
  it('no client can read rate_limits docs', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rate_limits/uid1_requestLoan'), { count: 1 });
    });

    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(adminCtx.firestore(), 'rate_limits/uid1_requestLoan')));

    const employeeCtx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(employeeCtx.firestore(), 'rate_limits/uid1_requestLoan')));
  });

  it('no client can write rate_limits docs', async () => {
    const adminCtx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(adminCtx.firestore(), 'rate_limits/uid1_requestLoan'), { count: 1 })
    );
  });
});

describe('default deny (VID3-710)', () => {
  it('reads on an unknown collection are denied for authenticated users', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(ctx.firestore(), 'some_random_coll/x')));
  });

  it('writes to an unknown collection are denied for authenticated users', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'some_random_coll/x'), { foo: 'bar' })
    );
  });
});
