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
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc } from 'firebase/firestore';
import * as path from 'path';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'vida-finance-test',
    firestore: {
      rules: readFileSync(path.resolve(__dirname, 'firestore.rules'), 'utf8'),
      host: 'localhost',
      port: 8080,
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

// ── employers collection ──────────────────────────────────────────────────────

describe('employers collection', () => {
  it('employer can read their own record', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
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

  it('employer create is denied for non-admins', async () => {
    const ctx = testEnv.authenticatedContext('employer1', { role: 'employer_admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'employers/employer1'), { name: 'My Company', status: 'pending' })
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

  it('employer delete is always denied', async () => {
    await seedEmployer('employer1');

    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(deleteDoc(doc(ctx.firestore(), 'employers/employer1')));
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
});

// ── Anonymous user denied everywhere ─────────────────────────────────────────

describe('unauthenticated user', () => {
  const collections = ['loans', 'employers', 'employees', 'audit_log', 'repayments', 'portfolio_snapshots'];

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

  it('disbursement_queue write is denied even for super_admin', async () => {
    const superAdmin = testEnv.authenticatedContext('super1', { role: 'super_admin' });
    await assertFails(
      setDoc(doc(superAdmin.firestore(), 'disbursement_queue/job2'), { loanId: 'loan2' })
    );
  });
});

// ── repayments collection ─────────────────────────────────────────────────────

describe('repayments collection', () => {
  async function seedRepayment(id: string, employeeId: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `repayments/${id}`), {
        employeeId,
        loanId: 'loan1',
        amount: 1300,
        method: 'card',
        status: 'completed',
      });
    });
  }

  it('employee can read their own repayment', async () => {
    await seedRepayment('rep1', 'employee1');
    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'repayments/rep1')));
  });

  it('employee cannot read another employee repayment', async () => {
    await seedRepayment('rep1', 'employee1');
    const ctx = testEnv.authenticatedContext('employee2', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'repayments/rep1')));
  });

  it('admin can read any repayment', async () => {
    await seedRepayment('rep1', 'employee1');
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'repayments/rep1')));
  });

  it('repayment write is denied for all clients', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'repayments/rep2'), { employeeId: 'employee1', amount: 500 })
    );
  });

  it('repayment update is denied even for employee', async () => {
    await seedRepayment('rep1', 'employee1');
    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(updateDoc(doc(ctx.firestore(), 'repayments/rep1'), { amount: 9999 }));
  });
});

// ── contact collection — public writes ───────────────────────────────────────

describe('contact collection', () => {
  it('unauthenticated user can create a contact submission', async () => {
    const ctx = testEnv.unauthenticatedContext();
    await assertSucceeds(
      addDoc(collection(ctx.firestore(), 'contact'), {
        name: 'Visitor',
        email: 'visitor@example.com',
        message: 'Hello',
      })
    );
  });

  it('authenticated non-admin cannot read contact submissions', async () => {
    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'contact/some-contact')));
  });

  it('admin can read contact submissions', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'contact/contact1'), { name: 'Test', email: 'test@test.com' });
    });
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'contact/contact1')));
  });
});

// ── ops-readable collections ──────────────────────────────────────────────────

describe('ops-readable operational collections', () => {
  it('ops can read scheduler_runs', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'scheduler_runs/run1'), { job: 'dailyLoanCheck', status: 'complete' });
    });
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'scheduler_runs/run1')));
  });

  it('employee cannot read scheduler_runs', async () => {
    const ctx = testEnv.authenticatedContext('employee1', { role: 'employee' });
    await assertFails(getDoc(doc(ctx.firestore(), 'scheduler_runs/run1')));
  });

  it('ops can read portfolio_snapshots', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'portfolio_snapshots/2025-01-01'), { totalActive: 10 });
    });
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'portfolio_snapshots/2025-01-01')));
  });

  it('scheduler_runs write is denied for ops', async () => {
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'scheduler_runs/fake'), { job: 'hacked' })
    );
  });

  it('ops can read system_health', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'system_health/current'), { status: 'ok' });
    });
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'system_health/current')));
  });
});

// ── admin-only log collections ────────────────────────────────────────────────

describe('admin-only log collections', () => {
  it('ops cannot read spei_log', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'spei_log/entry1'), { amount: 1000 });
    });
    const ctx = testEnv.authenticatedContext('ops1', { role: 'ops' });
    await assertFails(getDoc(doc(ctx.firestore(), 'spei_log/entry1')));
  });

  it('admin can read spei_log', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'spei_log/entry1'), { amount: 1000 });
    });
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'spei_log/entry1')));
  });

  it('admin cannot write to ml_decisions', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'ml_decisions/decision1'), { score: 0.9 })
    );
  });

  it('super_admin can read incident_log', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'incident_log/inc1'), { severity: 'critical' });
    });
    const ctx = testEnv.authenticatedContext('super1', { role: 'super_admin' });
    await assertSucceeds(getDoc(doc(ctx.firestore(), 'incident_log/inc1')));
  });
});

// ── catch-all: unknown collections denied ────────────────────────────────────

describe('unknown / unlisted collections (catch-all deny)', () => {
  it('authenticated user cannot access an unlisted collection', async () => {
    const ctx = testEnv.authenticatedContext('admin1', { admin: true, role: 'admin' });
    await assertFails(getDoc(doc(ctx.firestore(), 'unknown_collection/doc1')));
  });

  it('super_admin cannot write to an unlisted collection', async () => {
    const ctx = testEnv.authenticatedContext('super1', { role: 'super_admin' });
    await assertFails(
      setDoc(doc(ctx.firestore(), 'some_new_collection/doc1'), { data: 'value' })
    );
  });
});
