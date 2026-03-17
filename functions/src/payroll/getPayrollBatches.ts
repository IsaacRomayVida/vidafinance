import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

interface GetPayrollBatchesData {
  limit?: number;
  startAfter?: string;
}

interface BatchSummary {
  batchId: string;
  fileName: string;
  source: string;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createdAt: string;
  processedAt: string | null;
}

interface GetPayrollBatchesResult {
  batches: BatchSummary[];
  hasMore: boolean;
}

export const getPayrollBatches = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GetPayrollBatchesData, GetPayrollBatchesResult>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'getPayrollBatches', uid: auth.uid }, async () => {
        const { limit = 20, startAfter } = data;

        if (limit > 100) {
          throw new HttpsError('invalid-argument', 'Limit cannot exceed 100');
        }

        const db = getFirestore();
        let query = db
          .collection('payroll_batches')
          .where('employerId', '==', auth.uid)
          .orderBy('createdAt', 'desc')
          .limit(limit + 1);

        if (startAfter) {
          const cursorDoc = await db.collection('payroll_batches').doc(startAfter).get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snap = await query.get();
        const hasMore = snap.size > limit;
        const docs = hasMore ? snap.docs.slice(0, limit) : snap.docs;

        const batches: BatchSummary[] = docs.map((doc) => {
          const d = doc.data();
          return {
            batchId: doc.id,
            fileName: d['fileName'] as string,
            source: d['source'] as string,
            status: d['status'] as string,
            totalRows: (d['totalRows'] as number) ?? 0,
            validRows: (d['validRows'] as number) ?? 0,
            invalidRows: (d['invalidRows'] as number) ?? 0,
            createdAt:
              d['createdAt']
                ? new Date(
                    (d['createdAt'] as FirebaseFirestore.Timestamp).seconds * 1000,
                  ).toISOString()
                : '',
            processedAt: d['processedAt']
              ? new Date(
                  (d['processedAt'] as FirebaseFirestore.Timestamp).seconds * 1000,
                ).toISOString()
              : null,
          };
        });

        return { batches, hasMore };
      }),
  ),
);
