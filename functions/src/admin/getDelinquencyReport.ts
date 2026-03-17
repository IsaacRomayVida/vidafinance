import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

interface DelinquencyLoan {
  id: string;
  employeeName: string | null;
  employeePhone: string | null;
  employerId: string | null;
  employerName: string | null;
  amount: number;
  total: number;
  dueDate: FirebaseFirestore.Timestamp | null;
  status: string;
  overdueDetectedAt: FirebaseFirestore.Timestamp | null;
  daysOverdue: number;
  mlCreditScore: number | null;
  mlDefaultProb: number | null;
  createdAt: FirebaseFirestore.Timestamp | null;
}

export const getDelinquencyReport = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getDelinquencyReport', uid: auth.uid }, async () => {
      const db = getFirestore();
      const now = Timestamp.now();
      const nowMs = now.toMillis();

      const [overdueSnap, collectionsSnap, writtenOffSnap, overdueLogSnap] = await Promise.all([
        db.collection('loans').where('status', '==', 'overdue').get(),
        db.collection('loans').where('status', '==', 'in_collections').get(),
        db.collection('loans').where('status', '==', 'written_off').get(),
        db.collection('overdue_log').where('resolved', '==', false).orderBy('daysOverdue', 'desc').limit(200).get(),
      ]);

      const mapLoan = (d: FirebaseFirestore.QueryDocumentSnapshot): DelinquencyLoan => {
        const l = d.data();
        const dueDateMs = l['dueDate'] ? (l['dueDate'] as FirebaseFirestore.Timestamp).toMillis() : nowMs;
        const daysOverdue = Math.max(0, Math.floor((nowMs - dueDateMs) / 86400000));
        return {
          id: d.id,
          employeeName: l['employeeName'] ?? null,
          employeePhone: l['employeePhone'] ?? null,
          employerId: l['employerId'] ?? null,
          employerName: l['employerName'] ?? null,
          amount: l['amount'] ?? 0,
          total: l['total'] ?? l['repaymentAmount'] ?? 0,
          dueDate: l['dueDate'] ?? null,
          status: l['status'] ?? 'overdue',
          overdueDetectedAt: l['overdueDetectedAt'] ?? null,
          daysOverdue,
          mlCreditScore: l['mlCreditScore'] ?? null,
          mlDefaultProb: l['mlDefaultProb'] ?? null,
          createdAt: l['createdAt'] ?? null,
        };
      };

      const overdueLoans = overdueSnap.docs.map(mapLoan);
      const collectionsLoans = collectionsSnap.docs.map(mapLoan);
      const writtenOffLoans = writtenOffSnap.docs.map(mapLoan);

      // Aggregate by employer
      const byEmployer: Record<string, { name: string; count: number; totalExposure: number }> = {};
      [...overdueLoans, ...collectionsLoans].forEach((l) => {
        const eid = l.employerId ?? 'unknown';
        if (!byEmployer[eid]) byEmployer[eid] = { name: l.employerName ?? eid, count: 0, totalExposure: 0 };
        byEmployer[eid].count++;
        byEmployer[eid].totalExposure += l.total;
      });

      // Bucket by days overdue
      const buckets = {
        '1-7': overdueLoans.filter((l) => l.daysOverdue >= 1 && l.daysOverdue <= 7),
        '8-30': overdueLoans.filter((l) => l.daysOverdue >= 8 && l.daysOverdue <= 30),
        '31-60': overdueLoans.filter((l) => l.daysOverdue >= 31 && l.daysOverdue <= 60),
        '61+': overdueLoans.filter((l) => l.daysOverdue > 60),
      };

      const totalOverdueExposure = overdueLoans.reduce((s, l) => s + l.total, 0);
      const totalCollectionsExposure = collectionsLoans.reduce((s, l) => s + l.total, 0);
      const totalWrittenOff = writtenOffLoans.reduce((s, l) => s + l.total, 0);

      // All active + delinquent loan count for rate calculation
      const [activeCount, disbursedCount] = await Promise.all([
        db.collection('loans').where('status', '==', 'disbursed').count().get(),
        db.collection('loans').where('status', '==', 'repaid').count().get(),
      ]);

      const totalPortfolio =
        activeCount.data().count +
        overdueSnap.size +
        collectionsSnap.size +
        writtenOffSnap.size +
        disbursedCount.data().count;

      const delinquencyRate =
        totalPortfolio > 0
          ? (((overdueSnap.size + collectionsSnap.size) / totalPortfolio) * 100).toFixed(2)
          : '0.00';

      const recentOverdueLog = overdueLogSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      return {
        summary: {
          overdueCount: overdueSnap.size,
          inCollectionsCount: collectionsSnap.size,
          writtenOffCount: writtenOffSnap.size,
          totalOverdueExposureMXN: totalOverdueExposure,
          totalCollectionsExposureMXN: totalCollectionsExposure,
          totalWrittenOffMXN: totalWrittenOff,
          delinquencyRate: delinquencyRate + '%',
        },
        buckets: {
          '1-7_days': { count: buckets['1-7'].length, exposure: buckets['1-7'].reduce((s, l) => s + l.total, 0) },
          '8-30_days': { count: buckets['8-30'].length, exposure: buckets['8-30'].reduce((s, l) => s + l.total, 0) },
          '31-60_days': { count: buckets['31-60'].length, exposure: buckets['31-60'].reduce((s, l) => s + l.total, 0) },
          '61plus_days': { count: buckets['61+'].length, exposure: buckets['61+'].reduce((s, l) => s + l.total, 0) },
        },
        byEmployer: Object.entries(byEmployer).map(([id, v]) => ({ employerId: id, ...v })),
        overdueLoans: overdueLoans.sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 100),
        inCollectionsLoans: collectionsLoans.slice(0, 50),
        recentOverdueLog: recentOverdueLog.slice(0, 50),
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
