import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

export const getAdoptionMetrics = onCall(
  { enforceAppCheck: true },
  withAuth(['employer_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getAdoptionMetrics', uid: auth.uid }, async () => {
      const db = getFirestore();
      const employerId = auth.employerId;

      if (!employerId) {
        throw new HttpsError('failed-precondition', 'No employerId associated with this account');
      }

      const [employeesSnap, loansSnap] = await Promise.all([
        db.collection('employees').where('employerId', '==', employerId).get(),
        db.collection('loans').where('employerId', '==', employerId).get(),
      ]);

      const totalEmployees = employeesSnap.size;
      type LoanRecord = Record<string, unknown> & { id: string };
      const loans: LoanRecord[] = loansSnap.docs.map((d) => ({ id: d.id, ...d.data() } as LoanRecord));

      // Employees who have ever taken a loan
      const employeesWithLoans = new Set(loans.map((l) => l['employeeId'] as string));
      const adoptedCount = employeesWithLoans.size;
      const adoptionRate = totalEmployees > 0 ? (adoptedCount / totalEmployees) * 100 : 0;

      // Currently active borrowers (disbursed or overdue)
      const activeLoans = loans.filter(
        (l) => l['status'] === 'disbursed' || l['status'] === 'overdue'
      );
      const activeCount = new Set(activeLoans.map((l) => l['employeeId'] as string)).size;
      const activeRate = totalEmployees > 0 ? (activeCount / totalEmployees) * 100 : 0;

      // Average loan amount
      const avgLoanAmount =
        loans.length > 0
          ? loans.reduce((s, l) => s + ((l['amount'] as number) || 0), 0) / loans.length
          : 0;

      // Repayment rate (among closed loans)
      const closedLoans = loans.filter((l) =>
        ['repaid', 'paid', 'overdue', 'in_collections', 'written_off'].includes(
          l['status'] as string
        )
      );
      const repaidLoans = loans.filter(
        (l) => l['status'] === 'repaid' || l['status'] === 'paid'
      );
      const repaymentRate =
        closedLoans.length > 0 ? (repaidLoans.length / closedLoans.length) * 100 : 100;

      // Status breakdown
      const statusBreakdown = loans.reduce<Record<string, number>>((acc, l) => {
        const s = (l['status'] as string) ?? 'unknown';
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});

      // Monthly trend — last 6 months
      const now = new Date();
      const monthlyTrend = Array.from({ length: 6 }, (_, i) => {
        const offset = 5 - i;
        const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
        const startTs = Timestamp.fromDate(start);
        const endTs = Timestamp.fromDate(end);

        const monthLoans = loans.filter((l) => {
          const createdAt = l['createdAt'] as Timestamp | undefined;
          if (!createdAt?.toMillis) return false;
          const ms = createdAt.toMillis();
          return ms >= startTs.toMillis() && ms < endTs.toMillis();
        });

        return {
          month: start.toLocaleString('es-MX', { month: 'short', year: 'numeric' }),
          count: monthLoans.length,
          amount: monthLoans.reduce((s, l) => s + ((l['amount'] as number) || 0), 0),
        };
      });

      // Outstanding balance
      const outstandingBalance = activeLoans.reduce(
        (s, l) => s + ((l['total'] as number) || 0),
        0
      );

      return {
        totalEmployees,
        adoptedCount,
        adoptionRate: parseFloat(adoptionRate.toFixed(1)),
        activeCount,
        activeRate: parseFloat(activeRate.toFixed(1)),
        totalLoans: loans.length,
        avgLoanAmount: Math.round(avgLoanAmount),
        repaymentRate: parseFloat(repaymentRate.toFixed(1)),
        outstandingBalance,
        statusBreakdown,
        monthlyTrend,
      };
    })
  )
);
