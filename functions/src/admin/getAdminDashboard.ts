import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';
import { DISBURSED_STATUSES, REPAID_STATUSES } from '../loans/loanStatus';

export const getAdminDashboard = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (_data, auth) =>
    withErrorHandling({ functionName: 'getAdminDashboard', uid: auth.uid }, async () => {
      // Rate limit: 60/min/uid (read-only dashboard)
      try {
        const allowed = await checkRateLimit(`rl:getAdminDashboard:${auth.uid}`, 60, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

      const db = getFirestore();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [allActiveLoans, todayDisbursements, overdueLoans, employersSnap] = await Promise.all([
        // Both live disbursement spellings — 'active' (automatic SoftCrédito
        // path) and 'disbursed' (manual ops-confirmed path) — must be counted,
        // or the automatic-path half of the portfolio silently disappears.
        db.collection('loans').where('status', 'in', DISBURSED_STATUSES).get(),
        db
          .collection('loans')
          .where('disbursedAt', '>=', Timestamp.fromDate(today))
          .where('status', 'in', [...DISBURSED_STATUSES, ...REPAID_STATUSES])
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
