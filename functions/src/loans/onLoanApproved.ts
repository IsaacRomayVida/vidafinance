import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

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
  } catch (e: unknown) {
    console.warn('Queue unavailable:', (e as Error).message);
  }

  // Call PDF Generator HTTP endpoint to create loan contract
  try {
    const pdfBaseUrl = process.env['PDF_GENERATOR_URL'];
    if (!pdfBaseUrl) {
      console.warn('PDF_GENERATOR_URL not configured — skipping contract generation');
    } else {
      const r = await fetch(pdfBaseUrl + '/contracts/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
        },
        body: JSON.stringify({
          loanId,
          employeeId: after['employeeId'],
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: (AbortSignal as any).timeout(30000),
      });
      if (!r.ok) {
        console.warn(`PDF Generator returned ${r.status} for loan ${loanId}`);
      } else {
        const body = await r.json() as { contractUrl?: string };
        console.log(`Contract generated for loan ${loanId}: ${body.contractUrl}`);
      }
    }
  } catch (e: unknown) {
    console.warn('PDF Generator unavailable — skipping contract generation:', (e as Error).message);
  }

  return null;
});
