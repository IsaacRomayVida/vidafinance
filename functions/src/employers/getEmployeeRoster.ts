import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

export interface EmployeeRosterEntry {
  employeeId: string;
  name: string;
  email: string;
  phone: string | null;
  monthlySalary: number;
  availableCredit: number;
  creditLimit: number;
  bankName: string | null;
  active: boolean;
  createdAt: string | null;
  loanStatus: string | null;
  loanAmount: number | null;
  loanDueDate: string | null;
  loanId: string | null;
  totalLoansCount: number;
}

export const getEmployeeRoster = onCall(
  { enforceAppCheck: true },
  withAuth(['employer_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getEmployeeRoster', uid: auth.uid }, async () => {
      const db = getFirestore();
      const employerId = auth.employerId;

      if (!employerId) {
        throw new HttpsError('failed-precondition', 'No employerId associated with this account');
      }

      const [employeesSnap, activeLoansSnap, allLoansSnap] = await Promise.all([
        db.collection('employees').where('employerId', '==', employerId).get(),
        db
          .collection('loans')
          .where('employerId', '==', employerId)
          .where('status', 'in', ['pending', 'approved', 'pending_signature', 'disbursed', 'overdue'])
          .get(),
        db.collection('loans').where('employerId', '==', employerId).get(),
      ]);

      // Map latest active loan per employee
      const activeLoanByEmployee = new Map<string, { id: string } & Record<string, unknown>>();
      const statusPriority: Record<string, number> = {
        overdue: 0,
        disbursed: 1,
        pending_signature: 2,
        approved: 3,
        pending: 4,
      };
      activeLoansSnap.docs.forEach((doc) => {
        const loan = { id: doc.id, ...doc.data() } as { id: string } & Record<string, unknown>;
        const empId = loan['employeeId'] as string;
        const existing = activeLoanByEmployee.get(empId);
        if (
          !existing ||
          (statusPriority[loan['status'] as string] ?? 99) <
            (statusPriority[existing['status'] as string] ?? 99)
        ) {
          activeLoanByEmployee.set(empId, loan);
        }
      });

      // Count all loans per employee
      const loanCountByEmployee = new Map<string, number>();
      allLoansSnap.docs.forEach((doc) => {
        const empId = doc.data()['employeeId'] as string;
        loanCountByEmployee.set(empId, (loanCountByEmployee.get(empId) ?? 0) + 1);
      });

      const roster: EmployeeRosterEntry[] = employeesSnap.docs.map((doc) => {
        const emp = doc.data();
        const activeLoan = activeLoanByEmployee.get(doc.id);
        const dueDate = activeLoan?.['dueDate'] as Timestamp | undefined;

        return {
          employeeId: doc.id,
          name: (emp['name'] as string) || '',
          email: (emp['email'] as string) || '',
          phone: (emp['phone'] as string | null) ?? null,
          monthlySalary: (emp['monthlySalary'] as number) || 0,
          availableCredit: (emp['availableCredit'] as number) || 0,
          creditLimit: (emp['creditLimit'] as number) || 0,
          bankName: (emp['bankName'] as string | null) ?? null,
          active: emp['active'] !== false,
          createdAt: emp['createdAt']
            ? (emp['createdAt'] as Timestamp).toDate().toISOString()
            : null,
          loanStatus: activeLoan ? (activeLoan['status'] as string) : null,
          loanAmount: activeLoan ? ((activeLoan['amount'] as number) ?? null) : null,
          loanDueDate: dueDate ? dueDate.toDate().toISOString() : null,
          loanId: activeLoan ? activeLoan['id'] : null,
          totalLoansCount: loanCountByEmployee.get(doc.id) ?? 0,
        };
      });

      return { roster, total: roster.length };
    })
  )
);
