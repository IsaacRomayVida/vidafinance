import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { isDisbursedStatus, isRepaidStatus } from '../loans/loanStatus';

// NOT DEPLOYED — the live weeklyPortfolioSnapshot is the copy inline in
// index.ts (exported from there; see deploy.yml's FUNCTIONS list). Kept as a
// reference and fixed in lockstep so the two do not re-diverge.
export const weeklyPortfolioSnapshot = onSchedule(
  { schedule: '0 8 * * 1', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('loans').get();
    const loans = snap.docs.map((d) => d.data());

    // 'active' AND 'disbursed' are both live "funds sent" spellings, and
    // 'repaid' — not 'paid', which no write path has ever produced — is the
    // only spelling a full repayment is ever written with.
    const cnt = (pred: (s: string) => boolean) => loans.filter((l) => pred(l['status'] as string)).length;
    const sum = (pred: (s: string) => boolean) =>
      loans.filter((l) => pred(l['status'] as string)).reduce((a, l) => a + ((l['amount'] as number) || 0), 0);

    const active = cnt(isDisbursedStatus);
    const overdue = cnt((s) => s === 'overdue');
    const paid = cnt(isRepaidStatus);
    const total = active + overdue + paid;
    const date = new Date().toISOString().split('T')[0];

    await db.collection('portfolio_snapshots').doc(date).set({
      snapshotDate: date,
      totalActive: active,
      totalOverdue: overdue,
      totalPaid: paid,
      totalDisbursedMXN: sum(isDisbursedStatus) + sum((s) => s === 'overdue') + sum(isRepaidStatus),
      totalOutstandingMXN: sum(isDisbursedStatus) + sum((s) => s === 'overdue'),
      overdueRate: total > 0 ? overdue / total : 0,
      snapshotAt: FieldValue.serverTimestamp(),
    });
  }
);
