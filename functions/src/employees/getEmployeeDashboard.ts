import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

export const getEmployeeDashboard = onCall(
  { enforceAppCheck: true },
  withAuth(['employee'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getEmployeeDashboard', uid: auth.uid }, async () => {
      const db = getFirestore();
      const uid = auth.uid;

      const [employeeDoc, loansSnap] = await Promise.all([
        db.collection('employees').doc(uid).get(),
        db
          .collection('loans')
          .where('employeeId', '==', uid)
          .orderBy('createdAt', 'desc')
          .limit(20)
          .get(),
      ]);

      if (!employeeDoc.exists) {
        // Fall back to users collection for newer schema
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
          throw new HttpsError('not-found', 'Employee profile not found');
        }
        const user = userDoc.data()!;
        const userLoans = await db
          .collection('loans')
          .where('userId', '==', uid)
          .orderBy('requestedAt', 'desc')
          .limit(20)
          .get();

        const loans = userLoans.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));
        const activeLoans = loans.filter((l) =>
          ['pending', 'approved', 'disbursed', 'active'].includes(l['status'] as string)
        );

        return {
          employee: {
            name: user['fullName'],
            email: user['email'],
            employerId: user['employerId'],
            monthlySalary: user['monthlySalary'],
            availableCredit: user['availableCredit'] ?? null,
            kycStatus: user['kycStatus'],
          },
          loans,
          activeLoans: activeLoans.length,
          hasActiveLoan: activeLoans.length > 0,
        };
      }

      const emp = employeeDoc.data()!;
      const loans = loansSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));
      const activeLoans = loans.filter((l) =>
        ['pending', 'approved', 'active', 'disbursement_queued'].includes(l['status'] as string)
      );

      return {
        employee: {
          name: emp['name'],
          email: emp['email'],
          employerId: emp['employerId'],
          employerName: emp['employerName'],
          monthlySalary: emp['monthlySalary'],
          availableCredit: emp['availableCredit'],
          bankClabe: emp['bankClabe'] ? '****' + (emp['bankClabe'] as string).slice(-4) : null,
        },
        loans,
        activeLoans: activeLoans.length,
        hasActiveLoan: activeLoans.length > 0,
      };
    })
  )
);
