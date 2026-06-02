// DEPRECATED / NOT DEPLOYED. The canonical, deployed `onLoanApproved` lives inline in
// functions/src/index.ts (the only one re-exported). This richer variant (adds PDF
// contract + notifications) is retained as the reference for the planned merge, but it
// is not wired into index.ts exports. Keep its disbursement-failure handling in sync
// with index.ts until the two are consolidated.
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fetch from 'node-fetch';

import { getQueue } from '../utils/queue';
import { notifyLoanEvent } from '../utils/notify';

export const onLoanApproved = onDocumentUpdated('loans/{loanId}', async (event) => {
  const before = event.data!.before.data();
  const after = event.data!.after.data();
  if (!(before['status'] === 'pending' && after['status'] === 'approved')) return null;

  const db = getFirestore();
  const loanId = event.params['loanId'];
  const emp = (await db.collection('employees').doc(after['employeeId'] as string).get()).data() ?? {};
  const metamapVerificationId = (emp['metamapVerificationId'] as string | undefined) ?? null;

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
  await db.collection('loans').doc(loanId).update({
    status: 'disbursement_queued',
    metamapVerificationId,
  });

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
      logger.info('Loan disbursed via SoftCrédito', { loanId, ref: result.ref, service: 'functions' });
    } catch (e: unknown) {
      logger.error('SoftCrédito disbursement failed', { error: (e as Error).message, loanId, service: 'functions' });
      // Never mark the loan active on failure: that would report funds as sent
      // when no SPEI transfer occurred. Surface the failure for ops retry instead.
      try {
        await db.collection('loans').doc(loanId).update({
          status: 'disbursement_failed',
          disbursementError: (e as Error).message,
          disbursementFailedAt: FieldValue.serverTimestamp(),
        });
        await db.collection('disbursement_queue').doc(loanId).update({
          status: 'failed',
          error: (e as Error).message,
          failedAt: FieldValue.serverTimestamp(),
        });
      } catch (markErr: unknown) {
        logger.error('Failed to mark disbursement_failed', { error: (markErr as Error).message, loanId, service: 'functions' });
      }
    }
  } else if (process.env['ALLOW_STUB_DISBURSEMENT'] === 'true') {
    // Simulated disbursement — local/dev/test only, explicitly opted in.
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
      logger.info('Loan auto-disbursed (stub mode — ALLOW_STUB_DISBURSEMENT)', { loanId, service: 'functions' });
    } catch (e: unknown) {
      logger.warn('Stub disbursement error', { error: (e as Error).message, loanId, service: 'functions' });
    }
  } else {
    // Misconfiguration in a real environment — do not fake a disbursement.
    logger.error('SOFTCREDITO_ADAPTER_URL / INTERNAL_SECRET not configured — cannot disburse', { loanId, service: 'functions' });
    try {
      await db.collection('loans').doc(loanId).update({
        status: 'disbursement_failed',
        disbursementError: 'SOFTCREDITO_ADAPTER_URL or INTERNAL_SECRET not configured',
        disbursementFailedAt: FieldValue.serverTimestamp(),
      });
      await db.collection('disbursement_queue').doc(loanId).update({
        status: 'failed',
        error: 'adapter_not_configured',
        failedAt: FieldValue.serverTimestamp(),
      });
    } catch (e: unknown) {
      logger.error('Failed to mark disbursement_failed', { error: (e as Error).message, loanId, service: 'functions' });
    }
  }

  // Register payroll deduction with SoftCrédito
  try {
    const scUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
    const secret = process.env['INTERNAL_SECRET'] ?? '';
    if (scUrl && secret) {
      await fetch(scUrl + '/internal/register-deduction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({
          loanId,
          employeeId: after['employeeId'],
          employerId: after['employerId'],
          amount: after['total'],
          dueDate: (after['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: (AbortSignal as any).timeout(10000),
      }).then(async (r) => {
        if (r.ok) {
          const result = await r.json() as Record<string, unknown>;
          await db.collection('loans').doc(loanId).update({
            softcreditoDeductionId: result['deductionId'] ?? null,
          });
          logger.info('Payroll deduction registered', { loanId, service: 'functions' });
        }
      });
    }
  } catch (e: unknown) {
    logger.warn('Payroll deduction registration failed', { error: (e as Error).message, loanId, service: 'functions' });
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
    logger.warn('Queue unavailable', { error: (e as Error).message, loanId, service: 'functions' });
  }

  // Call PDF Generator HTTP endpoint to create loan contract
  try {
    const pdfBaseUrl = process.env['PDF_GENERATOR_URL'];
    if (!pdfBaseUrl) {
      logger.warn('PDF_GENERATOR_URL not configured — skipping contract generation', { loanId, service: 'functions' });
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
          metamapVerificationId,
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: (AbortSignal as any).timeout(30000),
      });
      if (!r.ok) {
        logger.warn('PDF Generator returned error', { status: r.status, loanId, service: 'functions' });
      } else {
        const body = await r.json() as { contractUrl?: string };
        logger.info('Contract generated', { loanId, contractUrl: body.contractUrl, service: 'functions' });
      }
    }
  } catch (e: unknown) {
    logger.warn('PDF Generator unavailable — skipping contract generation', { error: (e as Error).message, loanId, service: 'functions' });
  }

  // Notify employee of disbursement
  await notifyLoanEvent('loan_disbursed', { employeePhone: emp['phone'], employeeEmail: emp['email'], employeeName: after['employeeName'], loanAmount: after['amount'] }).catch(() => {});

  return null;
});
