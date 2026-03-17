import { onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const GetEmployerQueueSchema = z.object({
  status: z.enum(['pending_verification', 'active', 'rejected', 'rejected_ml']).default('pending_verification'),
  limit: z.number().int().min(1).max(100).default(50),
  startAfter: z.string().optional(),
});

export const getEmployerQueue = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'getEmployerQueue', uid: auth.uid }, async () => {
      const input = validateInput(GetEmployerQueueSchema, data);
      const db = getFirestore();

      let query = db
        .collection('employers')
        .where('status', '==', input.status)
        .orderBy('createdAt', 'desc')
        .limit(input.limit);

      if (input.startAfter) {
        const cursorDoc = await db.collection('employers').doc(input.startAfter).get();
        if (cursorDoc.exists) {
          query = query.startAfter(cursorDoc);
        }
      }

      const snap = await query.get();

      const employers = snap.docs.map((d) => {
        const e = d.data();
        return {
          id: d.id,
          companyName: e['companyName'] ?? null,
          name: e['name'] ?? null,
          email: e['email'] ?? null,
          employerCode: e['employerCode'] ?? null,
          status: e['status'] ?? null,
          industry: e['industry'] ?? null,
          companySize: e['companySize'] ?? null,
          payrollSystem: e['payrollSystem'] ?? null,
          rfc: e['rfc'] ?? null,
          satStatus: e['satStatus'] ?? null,
          mlScore: e['mlScore'] ?? e['mlRiskScore'] ?? null,
          riskTier: e['riskTier'] ?? null,
          mlDecisionId: e['mlDecisionId'] ?? null,
          llmAnalysis: e['llmAnalysis'] ?? null,
          red_flags: e['red_flags'] ?? [],
          green_flags: e['green_flags'] ?? [],
          requiresManualReview: e['requiresManualReview'] ?? false,
          docRFC: e['docRFC'] ?? null,
          docId: e['docId'] ?? null,
          docAddress: e['docAddress'] ?? null,
          rejectionReason: e['rejectionReason'] ?? null,
          rejectedAt: e['rejectedAt'] ?? null,
          activatedAt: e['activatedAt'] ?? null,
          createdAt: e['createdAt'] ?? null,
          activeLoans: e['activeLoans'] ?? 0,
          totalDisbursed: e['totalDisbursed'] ?? 0,
          currentOutstandingBalance: e['currentOutstandingBalance'] ?? 0,
        };
      });

      const lastId = snap.docs.length === input.limit ? snap.docs[snap.docs.length - 1].id : null;

      // Get counts for each status for badges
      const [pendingCount, rejectedCount, activeCount] = await Promise.all([
        db.collection('employers').where('status', '==', 'pending_verification').count().get(),
        db.collection('employers').where('status', '==', 'rejected').count().get(),
        db.collection('employers').where('status', '==', 'active').count().get(),
      ]);

      return {
        employers,
        nextCursor: lastId,
        hasMore: lastId !== null,
        counts: {
          pending_verification: pendingCount.data().count,
          rejected: rejectedCount.data().count,
          active: activeCount.data().count,
        },
      };
    })
  )
);
