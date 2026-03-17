import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { ALLOWED_ORIGINS } from '../utils/cors';

export const getEmployerDashboard = onCall(
  { cors: ALLOWED_ORIGINS, enforceAppCheck: true },
  withAuth(['employer_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getEmployerDashboard', uid: auth.uid }, async () => {
      const db = getFirestore();
      const employerId = auth.employerId;

      if (!employerId) {
        throw new HttpsError('failed-precondition', 'No employerId associated with this account');
      }

      const [employerDoc, loansSnap, employeesSnap] = await Promise.all([
        db.collection('employers').doc(employerId).get(),
        db
          .collection('loans')
          .where('employerId', '==', employerId)
          .where('status', 'in', ['disbursed', 'repaid', 'overdue'])
          .orderBy('requestedAt', 'desc')
          .limit(100)
          .get(),
        db
          .collection('employers')
          .doc(employerId)
          .collection('employees')
          .where('active', '==', true)
          .get(),
      ]);

      if (!employerDoc.exists) {
        throw new HttpsError('not-found', 'Employer not found');
      }

      const loans = loansSnap.docs.map((d) => d.data());
      const activeLoans = loans.filter((l) => l['status'] === 'disbursed');
      const overdueLoans = loans.filter((l) => l['status'] === 'overdue');
      const totalEmployees = employeesSnap.size || 1;

      return {
        employerId,
        companyName: employerDoc.data()?.['companyName'],
        stats: {
          totalEmployees: employeesSnap.size,
          activeLoans: activeLoans.length,
          totalDisbursed: loans.reduce((sum, l) => sum + ((l['principalAmount'] as number) || 0), 0),
          overdueCount: overdueLoans.length,
          adoptionRate: ((activeLoans.length / totalEmployees) * 100).toFixed(1) + '%',
          outstandingBalance: (employerDoc.data()?.['currentOutstandingBalance'] as number) ?? 0,
        },
        upcomingDeductions: activeLoans.map((l) => ({
          employeeId: l['userId'],
          amount: l['totalRepaymentAmount'],
          dueDate: l['dueDate'],
          loanId: l['loanId'],
        })),
      };
    })
  )
);
