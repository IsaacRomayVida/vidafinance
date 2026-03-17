import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

export interface PayrollDeductionEntry {
  loanId: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  amount: number;
  fee: number;
  total: number;
  status: string;
  dueDate: string | null;
  disbursedAt: string | null;
}

export const getPayrollDeductions = onCall(
  { enforceAppCheck: true },
  withAuth(['employer_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getPayrollDeductions', uid: auth.uid }, async () => {
      const db = getFirestore();
      const employerId = auth.employerId;

      if (!employerId) {
        throw new HttpsError('failed-precondition', 'No employerId associated with this account');
      }

      const loansSnap = await db
        .collection('loans')
        .where('employerId', '==', employerId)
        .where('status', 'in', ['disbursed', 'overdue'])
        .orderBy('dueDate', 'asc')
        .get();

      const deductions: PayrollDeductionEntry[] = loansSnap.docs.map((doc) => {
        const loan = doc.data();
        const dueDate = loan['dueDate'] as Timestamp | undefined;
        const disbursedAt = loan['disbursedAt'] as Timestamp | undefined;
        const amount = (loan['amount'] as number) ?? 0;
        const fee = (loan['fee'] as number) ?? 0;

        return {
          loanId: doc.id,
          employeeId: (loan['employeeId'] as string) ?? '',
          employeeName: (loan['employeeName'] as string) ?? '',
          employeeEmail: (loan['employeeEmail'] as string) ?? '',
          amount,
          fee,
          total: (loan['total'] as number) ?? amount + fee,
          status: (loan['status'] as string) ?? '',
          dueDate: dueDate ? dueDate.toDate().toISOString() : null,
          disbursedAt: disbursedAt ? disbursedAt.toDate().toISOString() : null,
        };
      });

      const totalDeductionAmount = deductions.reduce((sum, d) => sum + d.total, 0);
      const overdueCount = deductions.filter((d) => d.status === 'overdue').length;

      return {
        deductions,
        total: deductions.length,
        totalDeductionAmount,
        overdueCount,
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
