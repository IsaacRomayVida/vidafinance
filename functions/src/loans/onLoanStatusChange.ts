import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { auditLog } from '../utils/auditLog';
import { isCreditRestoringRepayment } from './loanStatus';

// NOT DEPLOYED — the live onLoanStatusChange is the copy inline in index.ts
// (exported from there; see deploy.yml's FUNCTIONS list). Kept as a reference
// and fixed in lockstep so the two do not re-diverge.
export const onLoanStatusChange = onDocumentUpdated('loans/{loanId}', async (event) => {
  const beforeData = event.data!.before.data();
  const afterData = event.data!.after.data();
  const loanId = event.params['loanId'];
  const db = getFirestore();

  if (beforeData['status'] === 'pending' && afterData['status'] === 'approved') {
    await db.collection('employers').doc(afterData['employerId'] as string).update({
      activeLoans: FieldValue.increment(1),
      totalDisbursed: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog({
        action: 'loan.approved',
        actorUid: afterData['employerId'] as string,
        actorRole: 'employer',
        targetId: loanId,
        before: { status: 'pending' },
        after: { status: 'approved' },
      });
    } catch (_) { /* non-critical */ }
  }

  if (beforeData['status'] === 'pending' && afterData['status'] === 'rejected') {
    await db.collection('employees').doc(afterData['employeeId'] as string).update({
      availableCredit: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog({
        action: 'loan.rejected',
        actorUid: afterData['employerId'] as string,
        actorRole: 'employer',
        targetId: loanId,
        before: { status: 'pending' },
        after: { status: 'rejected' },
      });
    } catch (_) { /* non-critical */ }
  }

  // Canonical 'repaid' only -- payment-server writes 'paid' and restores the
  // employee's availableCredit itself, so firing on that spelling too would
  // credit it twice. See isCreditRestoringRepayment in ./loanStatus.
  if (isCreditRestoringRepayment(beforeData['status'], afterData['status'])) {
    await db.collection('employers').doc(afterData['employerId'] as string).update({
      activeLoans: FieldValue.increment(-1),
    });
    await db.collection('employees').doc(afterData['employeeId'] as string).update({
      availableCredit: FieldValue.increment(afterData['amount'] as number),
    });
    try {
      await auditLog({
        action: 'loan.repaid',
        actorUid: afterData['employeeId'] as string,
        actorRole: 'employee',
        targetId: loanId,
        before: { status: beforeData['status'] },
        after: { status: afterData['status'] },
      });
    } catch (_) { /* non-critical */ }
  }
});
