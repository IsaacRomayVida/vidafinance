import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { CORS_ORIGINS } from '../utils/corsOrigins';

export const getAdminDashboard = onCall(
  { cors: CORS_ORIGINS, enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getAdminDashboard', uid: auth.uid }, async () => {
      const db = getFirestore();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [allActiveLoans, todayDisbursements, overdueLoans, employersSnap] = await Promise.all([
        db.collection('loans').where('status', '==', 'disbursed').get(),
        db
          .collection('loans')
          .where('disbursedAt', '>=', Timestamp.fromDate(today))
          .where('status', 'in', ['disbursed', 'repaid'])
          .get(),
        db.collection('loans').where('status', '==', 'overdue').get(),
        db.collection('employers').where('status', '==', 'approved').get(),
      ]);

      const activePortfolioValue = allActiveLoans.docs.reduce(
        (sum, d) => sum + ((d.data()['principalAmount'] as number) || 0),
        0
      );
      const todayVolume = todayDisbursements.docs.reduce(
        (sum, d) => sum + ((d.data()['principalAmount'] as number) || 0),
        0
      );

      return {
        portfolio: {
          activeLoans: allActiveLoans.size,
          activePortfolioMXN: activePortfolioValue,
          overdueLoans: overdueLoans.size,
          defaultRate:
            (
              (overdueLoans.size / (allActiveLoans.size || 1)) *
              100
            ).toFixed(2) + '%',
        },
        today: {
          disbursements: todayDisbursements.size,
          volumeMXN: todayVolume,
        },
        employers: {
          total: employersSnap.size,
          list: employersSnap.docs.map((d) => ({
            name: d.data()['companyName'],
            employerId: d.id,
            outstandingBalance: d.data()['currentOutstandingBalance'],
          })),
        },
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
