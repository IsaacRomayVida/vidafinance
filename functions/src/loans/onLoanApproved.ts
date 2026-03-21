import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { getQueue } from '../utils/queue';

export const onLoanApproved = onDocumentUpdated('loans/{loanId}', async (event) => {
  const before = event.data!.before.data();
  const after = event.data!.after.data();
  if (!(before['status'] === 'pending' && after['status'] === 'approved')) return null;

  const db = getFirestore();
  const loanId = event.params['loanId'];
  const emp = (await db.collection('employees').doc(after['employeeId'] as string).get()).data() ?? {};

  await db.collection('disbursement_queue').doc(loanId).set({
    loanId,
    employeeId: after['employeeId'],
    employeeName: after['employeeName'],
    employerName: after['employerName'],
    amount: after['amount'],
    total: after['total'],
    clabe: emp['bankClabe'] ?? null,
    bankName: emp['bankName'] ?? null,
    concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
    status: 'queued',
    queuedAt: FieldValue.serverTimestamp(),
  });
  await db.collection('loans').doc(loanId).update({ status: 'disbursement_queued' });

  try {
    await getQueue('vida-disbursements').add('disburse', {
      loanId,
      employeeId: after['employeeId'],
      amount: after['amount'],
      clabe: emp['bankClabe'],
      concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
      employeeName: after['employeeName'],
      employerName: after['employerName'],
    });
    await getQueue('vida-notifications').add('loan_approved', {
      type: 'loan_approved',
      loanId,
      employeeId: after['employeeId'],
      employeeName: after['employeeName'],
      phone: emp['phone'],
      amount: after['amount'],
    });
    await getQueue('vida-pdfs').add('loan_contract', {
      type: 'loan_contract',
      loanId,
      employeeId: after['employeeId'],
      employeeName: after['employeeName'],
      employerName: after['employerName'],
      amount: after['amount'],
      total: after['total'],
      fee: after['fee'],
      dueDate: (after['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
    });
  } catch (e: unknown) {
    console.warn('Queue unavailable:', (e as Error).message);
  }

  return null;
});
