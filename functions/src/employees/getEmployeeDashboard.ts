import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';
import { OUTSTANDING_STATUSES } from '../loans/loanStatus';

export const getEmployeeDashboard = onCall(
  { enforceAppCheck: true },
  withAuth(['employee'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getEmployeeDashboard', uid: auth.uid }, async () => {
      // Rate limit: 60/min/uid (read-only dashboard)
      // Deliberately fails OPEN. This is a read-only view: the limit is
      // here to protect capacity, not money or secrets, so a limiter
      // outage should degrade to an unthrottled dashboard rather than
      // to a dashboard nobody can open. Contrast the spend- and
      // enumeration-critical limits, which fail closed.
      await enforceRateLimit(`rl:getEmployeeDashboard:${auth.uid}`, 60, 60, {
        onUnavailable: 'open',
        context: 'getEmployeeDashboard',
      });

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
        const activeLoans = loans.filter((l) => OUTSTANDING_STATUSES.includes(l['status'] as string));

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
      const activeLoans = loans.filter((l) => OUTSTANDING_STATUSES.includes(l['status'] as string));

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
