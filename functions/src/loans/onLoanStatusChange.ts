import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { auditLog } from '../utils/auditLog';

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

  if (beforeData['status'] === 'approved' && afterData['status'] === 'paid') {
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
        before: { status: 'approved' },
        after: { status: 'paid' },
      });
    } catch (_) { /* non-critical */ }
  }
});
