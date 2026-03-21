import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { auditLog } from '../utils/auditLog';
import { getQueue } from '../utils/queue';

export const dailyLoanCheck = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();

    const overdueSnap = await db
      .collection('loans')
      .where('status', '==', 'active')
      .where('dueDate', '<', now)
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
    const remindSnap = await db
      .collection('loans')
      .where('status', '==', 'active')
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
      status: 'complete',
    });
  }
);
