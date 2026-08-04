import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { startOfDay } from '../loans/calculateNextPayrollDate';
import { DISBURSED_STATUSES } from '../loans/loanStatus';
import { auditLog } from '../utils/auditLog';
import { getQueue } from '../utils/queue';

export const dailyLoanCheck = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();

    // A loan is late the day AFTER its due date, not on it.
    //
    // `loan.dueDate` is a payday, written by calculateNextPayrollDate as the
    // midnight that STARTS that day. The borrower is paid, and the SoftCrédito
    // deduction registered against that same date is collected, at some point
    // DURING it. This sweep fires at 09:00, so comparing against `now` made
    // every loan due today overdue this morning — hours before the payroll run
    // that repays it, and with nothing the borrower could have done differently.
    // The job's own arithmetic said as much: `daysOver` below came out 0, and
    // it wrote "0 days overdue" to overdue_log, sent the borrower an SMS
    // warning of additional fees, and put them on the employer's arrears page.
    //
    // The cutoff is the start of today, from the same helper that produced the
    // due dates, so a loan is only swept once its due day has fully elapsed.
    const overdueCutoff = Timestamp.fromDate(startOfDay(now.toDate()));

    // ── Sync repayments from SoftCrédito payroll deductions ──────────
    let repaymentsSynced = 0;
    let repaymentSyncError: string | null = null;
    try {
      const adapterUrl = process.env['SOFTCREDITO_ADAPTER_URL'];
      if (!adapterUrl) {
        // Not "nothing to do" — it means we have no idea which loans were
        // repaid by payroll since yesterday, which is the same blindness as a
        // failed call and must gate the sweep the same way.
        repaymentSyncError = 'SOFTCREDITO_ADAPTER_URL not configured';
      } else {
        const resp = await fetch(adapterUrl + '/internal/sync-repayments', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signal: (AbortSignal as any).timeout(30_000),
        });
        if (resp.ok) {
          const body = (await resp.json()) as { synced?: number };
          repaymentsSynced = body.synced ?? 0;
        } else {
          repaymentSyncError = `HTTP ${resp.status}`;
        }
      }
    } catch (err) {
      repaymentSyncError = err instanceof Error ? err.message : 'unknown error';
    }

    // Marking a loan overdue is an adverse action against the borrower: it
    // writes overdue_log, dunns them over the notification queue, and shows up
    // in arrears reporting. It is only sound if we know what payroll collected
    // since yesterday. When the repayment sync failed — or never ran, because
    // the adapter URL is unconfigured — that knowledge is stale, and sweeping
    // anyway flips loans the borrower has already paid. Skip the sweep and
    // record the run as degraded so it is visible rather than silent; the next
    // run picks these loans up once the sync is healthy again.
    const overdueSnap = repaymentSyncError
      ? { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[], size: 0 }
      : await db
          .collection('loans')
          // Both live "funds were actually sent" spellings: 'active' (the
          // automatic onLoanApproved path) and 'disbursed' (markLoanDisbursed,
          // the manual ops-confirmed path). This used to be `== 'active'`, so
          // every manually-disbursed loan was invisible to the sweep and never
          // went overdue at all. Firestore serves `in` from the same
          // (status, dueDate) composite index as `==`, so no index change.
          .where('status', 'in', DISBURSED_STATUSES)
          .where('dueDate', '<', overdueCutoff)
          .get();

    for (const doc of overdueSnap.docs) {
      const loan = doc.data();
      const daysOver = Math.floor(
        (Date.now() - (loan['dueDate'] as FirebaseFirestore.Timestamp).toMillis()) / 86400000
      );

      await doc.ref.update({ status: 'overdue', overdueDetectedAt: now });

      await db.collection('overdue_log').doc(doc.id).set({
        loanId: doc.id,
        employeeId: loan['employeeId'],
        employerId: loan['employerId'],
        employeeName: loan['employeeName'],
        amount: loan['total'],
        dueDate: loan['dueDate'],
        daysOverdue: daysOver,
        detectedAt: now,
        resolved: false,
      });

      try {
        await getQueue('vida-notifications').add('loan_overdue', {
          type: 'loan_overdue',
          loanId: doc.id,
          employeeId: loan['employeeId'],
          phone: loan['employeePhone'],
          amount: loan['total'],
          dueDate: (loan['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
          daysOverdue: daysOver,
        });
      } catch (_) { /* queue unavailable */ }

      try {
        await auditLog({
          action: 'loan.overdue_detected',
          actorUid: 'system',
          actorRole: 'system',
          targetId: doc.id,
        });
      } catch (_) { /* non-critical */ }
    }

    const tomorrow = Timestamp.fromMillis(Date.now() + 25 * 60 * 60 * 1000);
    // The reminder pass is NOT gated on the sync: a heads-up to a borrower who
    // has in fact already paid is harmless, whereas withholding it from one who
    // has not is the failure that costs them. Same 'active'/'disbursed' fix.
    const remindSnap = await db
      .collection('loans')
      .where('status', 'in', DISBURSED_STATUSES)
      .where('dueDate', '<', tomorrow)
      .get();

    for (const doc of remindSnap.docs) {
      const loan = doc.data();
      if ((loan['dueDate'] as FirebaseFirestore.Timestamp).toMillis() < Date.now()) continue;
      try {
        await getQueue('vida-notifications').add('loan_reminder_24h', {
          type: 'loan_reminder_24h',
          loanId: doc.id,
          employeeId: loan['employeeId'],
          phone: loan['employeePhone'],
          amount: loan['total'],
          dueDate: (loan['dueDate'] as FirebaseFirestore.Timestamp).toDate().toISOString(),
        });
      } catch (_) { /* queue unavailable */ }
    }

    await db.collection('scheduler_runs').add({
      job: 'dailyLoanCheck',
      ranAt: now,
      overdueFound: overdueSnap.size,
      repaymentsSynced,
      ...(repaymentSyncError ? { repaymentSyncError } : {}),
      // 'degraded' means the overdue sweep was deliberately skipped this run.
      status: repaymentSyncError ? 'degraded' : 'complete',
    });
  }
);
