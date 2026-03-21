/**
 * Internal routes for SPEI disbursements, employer/deduction registration,
 * and daily repayment sync. Called by payment-server and Firebase Functions
 * via x-internal-secret authentication.
 */
import { Router } from 'express';
import axios from 'axios';
import pino from 'pino';
import { requireInternalSecret } from '../lib/internalAuth';
import { db } from '../lib/firestore';
import admin from '../lib/firestore';

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const router = Router();

// ── SoftCrédito SPEI token cache ────────────────────────────────────
let _token: string | null = null;
let _tokenExp = 0;

async function scToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp - 60_000) return _token;

  const res = await axios.post<{ access_token: string; expires_in: number }>(
    `${process.env.SOFTCREDITO_API_URL}/auth/token`,
    {
      clientId: process.env.SOFTCREDITO_CLIENT_ID || process.env.SOFTCREDITO_USER,
      clientSecret: process.env.SOFTCREDITO_CLIENT_SECRET || process.env.SOFTCREDITO_PASSWORD,
    },
  );

  _token = res.data.access_token;
  _tokenExp = Date.now() + res.data.expires_in * 1000;
  return _token;
}

async function scCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await scToken();
  const res = await axios.request<T>({
    method,
    url: `${process.env.SOFTCREDITO_API_URL}${path}`,
    headers: { Authorization: `Bearer ${token}` },
    data: body,
    timeout: 20_000,
  });
  return res.data;
}

// ── SPEI disbursement ───────────────────────────────────────────────
router.post('/internal/disburse', requireInternalSecret, async (req, res) => {
  const { loanId, clabe, amount, concept, employeeName, employeeId } = req.body as {
    loanId?: string;
    clabe?: string;
    amount?: number;
    concept?: string;
    employeeName?: string;
    employeeId?: string;
  };

  if (!loanId || !clabe || !amount) {
    res.status(400).json({ error: 'Missing required fields: loanId, clabe, amount' });
    return;
  }

  try {
    const r = await scCall<{ trackingCode?: string; reference?: string; transferId?: string }>(
      'POST',
      '/spei/transfer',
      {
        destinationClabe: clabe,
        amount,
        concept,
        recipientName: employeeName,
        reference: loanId.slice(0, 7).toUpperCase(),
        metadata: { loanId, employeeId },
      },
    );

    await db.collection('loans').doc(loanId).update({
      status: 'active',
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      disbursementRef: r.trackingCode || r.reference,
      softcreditoTransferId: r.transferId,
    });

    await db.collection('disbursement_queue').doc(loanId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      speiRef: r.trackingCode,
    });

    await db.collection('spei_log').add({
      loanId,
      employeeId,
      amount,
      clabe,
      concept,
      speiRef: r.trackingCode,
      disbursedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'sent',
    });

    res.json({ success: true, ref: r.trackingCode, transferId: r.transferId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    log.error({ error: message, loanId, service: 'softcredito-adapter' }, 'SPEI disbursement error');
    res.status(500).json({ error: message });
  }
});

// ── Register employer with SoftCrédito ─────────────────────────────
router.post('/internal/register-employer', requireInternalSecret, async (req, res) => {
  const { employerUid, companyName, rfc, clabe, contactEmail } = req.body as {
    employerUid?: string;
    companyName?: string;
    rfc?: string;
    clabe?: string;
    contactEmail?: string;
  };

  if (!employerUid) {
    res.status(400).json({ error: 'employerUid is required' });
    return;
  }

  try {
    const r = await scCall<{ employerId: string }>('POST', '/employers/register', {
      name: companyName,
      rfc,
      payrollClabe: clabe,
      contactEmail,
      metadata: { firebaseUid: employerUid },
    });

    await db.collection('employers').doc(employerUid).update({
      softcreditoEmployerId: r.employerId,
      softcreditoRegisteredAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('softcredito_employers').doc(employerUid).set({
      employerId: r.employerId,
      companyName,
      rfc,
      clabe,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
    });

    res.json({ success: true, employerId: r.employerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    res.status(500).json({ error: message });
  }
});

// ── Register payroll deduction for a loan ──────────────────────────
router.post('/internal/register-deduction', requireInternalSecret, async (req, res) => {
  const { loanId, employeeId, employerId, amount, dueDate } = req.body as {
    loanId?: string;
    employeeId?: string;
    employerId?: string;
    amount?: number;
    dueDate?: string;
  };

  if (!loanId || !employeeId || !employerId) {
    res.status(400).json({ error: 'Missing required fields: loanId, employeeId, employerId' });
    return;
  }

  try {
    const [empDoc, employeeDoc] = await Promise.all([
      db.collection('employers').doc(employerId).get(),
      db.collection('employees').doc(employeeId).get(),
    ]);

    const emp = empDoc.data();
    if (!emp?.softcreditoEmployerId) {
      throw new Error('Employer not registered with SoftCrédito');
    }

    const employee = employeeDoc.data();
    const r = await scCall<{ deductionId: string }>('POST', '/deductions/register', {
      softcreditoEmployerId: emp.softcreditoEmployerId,
      employeeClabe: employee?.bankClabe,
      amount,
      deductionDate: dueDate,
      reference: loanId.slice(0, 7).toUpperCase(),
      metadata: { loanId, employeeId },
    });

    await db.collection('loans').doc(loanId).update({
      softcreditoDeductionId: r.deductionId,
    });

    res.json({ success: true, deductionId: r.deductionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    res.status(500).json({ error: message });
  }
});

// ── Daily repayment sync ────────────────────────────────────────────
router.post('/internal/sync-repayments', requireInternalSecret, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await scCall<{ deductions?: Array<{ deductionId: string; amount: number; reference: string }> }>(
      'GET',
      `/deductions/completed?date=${today}`,
    );

    let synced = 0;
    for (const item of data.deductions ?? []) {
      const snap = await db
        .collection('loans')
        .where('softcreditoDeductionId', '==', item.deductionId)
        .limit(1)
        .get();

      if (snap.empty || snap.docs[0].data().status === 'paid') continue;

      const loanId = snap.docs[0].id;
      const loan = snap.docs[0].data();

      await axios.post(
        `${process.env.PAYMENT_SERVER_URL}/internal/repayment`,
        {
          loanId,
          employeeId: loan.employeeId,
          amount: item.amount,
          ref: item.reference,
          method: 'payroll_deduction',
        },
        {
          headers: {
            'x-internal-secret': process.env.INTERNAL_SECRET || process.env.INTERNAL_API_SECRET,
          },
          timeout: 10_000,
        },
      );

      synced++;
    }

    res.json({ success: true, synced });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    res.status(500).json({ error: message });
  }
});

export default router;
