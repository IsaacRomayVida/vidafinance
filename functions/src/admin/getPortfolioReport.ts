import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';
import { checkRateLimit } from '../utils/rateLimiter';
import { POST_DISBURSEMENT_STATUSES, DEFAULT_STATUSES, isRepaidStatus } from '../loans/loanStatus';

const PortfolioReportSchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']),
});

function getPeriodCutoff(period: '7d' | '30d' | '90d' | 'all'): Timestamp {
  if (period === 'all') return Timestamp.fromMillis(0);
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return Timestamp.fromDate(cutoffDate);
}

export const getPortfolioReport = onCall(
  { enforceAppCheck: true },
  withAuth(['admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'getPortfolioReport', uid: auth.uid }, async () => {
      // Rate limit: 10/min/uid (expensive aggregation)
      try {
        const allowed = await checkRateLimit(`rl:getPortfolioReport:${auth.uid}`, 10, 60);
        if (!allowed) {
          throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
        }
      } catch (e: unknown) {
        if (e instanceof HttpsError) throw e;
        logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
      }

      const { period } = validateInput(PortfolioReportSchema, data);
      const db = getFirestore();
      const cutoff = getPeriodCutoff(period);

      const allLoansSnap = await db
        .collection('loans')
        .where('requestedAt', '>=', cutoff)
        .get();

      const loans = allLoansSnap.docs.map((d) => d.data());

      const byStatus = loans.reduce((acc, l) => {
        const status = l['status'] as string;
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const byEmployer: Record<string, { count: number; volume: number }> = {};
      loans.forEach((l) => {
        const eid = l['employerId'] as string;
        if (!byEmployer[eid]) byEmployer[eid] = { count: 0, volume: 0 };
        byEmployer[eid].count++;
        byEmployer[eid].volume += (l['principalAmount'] as number) || 0;
      });

      // Every status from "funds sent" onward — this must include BOTH live
      // disbursement spellings ('active' from the automatic SoftCrédito path,
      // 'disbursed' from the manual ops-confirmed path), not just one of them,
      // or half the disbursed portfolio silently drops out of this total.
      const totalDisbursed = loans
        .filter((l) => POST_DISBURSEMENT_STATUSES.includes(l['status'] as string))
        .reduce((sum, l) => sum + ((l['principalAmount'] as number) || 0), 0);

      const totalRepaid = loans
        .filter((l) => isRepaidStatus(l['status']))
        .reduce((sum, l) => sum + ((l['totalRepaymentAmount'] as number) || 0), 0);

      const totalRevenue = loans
        .filter((l) => isRepaidStatus(l['status']))
        .reduce((sum, l) => sum + ((l['feeAmount'] as number) || 0), 0);

      const defaultCount = loans.filter((l) =>
        DEFAULT_STATUSES.includes(l['status'] as string)
      ).length;

      return {
        period,
        summary: {
          totalLoans: loans.length,
          totalDisbursedMXN: totalDisbursed,
          totalRepaidMXN: totalRepaid,
          totalRevenueMXN: totalRevenue,
          defaultRate: ((defaultCount / (loans.length || 1)) * 100).toFixed(2) + '%',
        },
        byStatus,
        byEmployer,
        generatedAt: new Date().toISOString(),
      };
    })
  )
);
