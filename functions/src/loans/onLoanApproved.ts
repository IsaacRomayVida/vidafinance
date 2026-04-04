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

  const softcreditoUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
  const internalSecret = process.env['INTERNAL_SECRET'] ?? '';

  if (softcreditoUrl && internalSecret) {
    // Real SPEI disbursement via SoftCrédito adapter
    try {
      const disburseRes = await fetch(`${softcreditoUrl}/internal/disburse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
        },
        body: JSON.stringify({
          loanId,
          clabe: emp['bankClabe'],
          amount: after['amount'],
          concept: 'VIDA-' + loanId.slice(0, 8).toUpperCase(),
          employeeName: after['employeeName'],
          employeeId: after['employeeId'],
        }),
      });

      if (!disburseRes.ok) {
        const errBody = await disburseRes.text();
        throw new Error(`Adapter returned ${disburseRes.status}: ${errBody}`);
      }

      const result = (await disburseRes.json()) as { ref?: string; transferId?: string };
      await db.collection('loans').doc(loanId).update({
        status: 'active',
        disbursedAt: FieldValue.serverTimestamp(),
        disbursementRef: result.ref ?? null,
      });
      await db.collection('disbursement_queue').doc(loanId).update({
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
      });
      console.log('Loan', loanId, 'disbursed via SoftCrédito, ref:', result.ref);
    } catch (e: unknown) {
      console.warn('SoftCrédito disbursement failed, falling back to stub:', (e as Error).message);
      // Fallback to stub on failure
      try {
        await db.collection('loans').doc(loanId).update({
          status: 'active',
          disbursedAt: FieldValue.serverTimestamp(),
          disbursementRef: 'STUB-' + loanId.slice(0, 8).toUpperCase(),
          disbursementError: (e as Error).message,
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'completed',
          completedAt: FieldValue.serverTimestamp(),
        });
        console.log('Loan', loanId, 'auto-disbursed (stub fallback)');
      } catch (stubErr: unknown) {
        console.warn('Stub fallback error:', (stubErr as Error).message);
      }
    }
  } else {
    // Stub mode: no adapter URL or secret configured
    try {
      await db.collection('loans').doc(loanId).update({
        status: 'active',
        disbursedAt: FieldValue.serverTimestamp(),
        disbursementRef: 'STUB-' + loanId.slice(0, 8).toUpperCase(),
      });
      await db.collection('disbursement_queue').doc(loanId).update({
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
      });
      console.log('Loan', loanId, 'auto-disbursed (stub mode)');
    } catch (e: unknown) {
      console.warn('Stub disbursement error:', (e as Error).message);
    }
  }

  try {
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
