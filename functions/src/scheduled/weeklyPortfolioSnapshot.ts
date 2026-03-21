import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const weeklyPortfolioSnapshot = onSchedule(
  { schedule: '0 8 * * 1', timeZone: 'America/Mexico_City' },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('loans').get();
    const loans = snap.docs.map((d) => d.data());

    const cnt = (s: string) => loans.filter((l) => l['status'] === s).length;
    const sum = (s: string) =>
      loans.filter((l) => l['status'] === s).reduce((a, l) => a + ((l['amount'] as number) || 0), 0);

    const active = cnt('active');
    const overdue = cnt('overdue');
    const paid = cnt('paid');
    const total = active + overdue + paid;
    const date = new Date().toISOString().split('T')[0];

    await db.collection('portfolio_snapshots').doc(date).set({
      snapshotDate: date,
      totalActive: active,
      totalOverdue: overdue,
      totalPaid: paid,
      totalDisbursedMXN: sum('active') + sum('overdue') + sum('paid'),
      totalOutstandingMXN: sum('active') + sum('overdue'),
      overdueRate: total > 0 ? overdue / total : 0,
      snapshotAt: FieldValue.serverTimestamp(),
    });
  }
);
