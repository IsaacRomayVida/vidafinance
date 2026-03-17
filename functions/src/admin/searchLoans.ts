import { onCall } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const LoanStatus = z.enum([
  'pending', 'approved', 'pending_signature', 'disbursed',
  'repaid', 'overdue', 'in_collections', 'written_off', 'cancelled',
]);

const SearchLoansSchema = z.object({
  status: LoanStatus.optional(),
  employerId: z.string().optional(),
  employeeQuery: z.string().max(100).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(100),
  startAfter: z.string().optional(),
});

export const searchLoans = onCall(
  { enforceAppCheck: true },
  withAuth(['ops', 'admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'searchLoans', uid: auth.uid }, async () => {
      const input = validateInput(SearchLoansSchema, data);
      const db = getFirestore();

      // Build base query with indexed fields first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = db.collection('loans');

      if (input.status) {
        query = query.where('status', '==', input.status);
      }
      if (input.employerId) {
        query = query.where('employerId', '==', input.employerId);
      }
      if (input.dateFrom) {
        const fromDate = new Date(input.dateFrom);
        fromDate.setHours(0, 0, 0, 0);
        query = query.where('createdAt', '>=', Timestamp.fromDate(fromDate));
      }
      if (input.dateTo) {
        const toDate = new Date(input.dateTo);
        toDate.setHours(23, 59, 59, 999);
        query = query.where('createdAt', '<=', Timestamp.fromDate(toDate));
      }

      query = query.orderBy('createdAt', 'desc').limit(input.limit + 1);

      if (input.startAfter) {
        const cursorDoc = await db.collection('loans').doc(input.startAfter).get();
        if (cursorDoc.exists) {
          query = query.startAfter(cursorDoc);
        }
      }

      const snap = await query.get();

      let loans = snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => {
        const l = d.data();
        return {
          id: d.id,
          employeeId: l['employeeId'] ?? null,
          employeeName: l['employeeName'] ?? null,
          employeeEmail: l['employeeEmail'] ?? null,
          employeePhone: l['employeePhone'] ?? null,
          employerId: l['employerId'] ?? null,
          employerName: l['employerName'] ?? null,
          employerCode: l['employerCode'] ?? null,
          amount: l['amount'] ?? 0,
          fee: l['fee'] ?? 0,
          total: l['total'] ?? 0,
          term: l['term'] ?? 30,
          status: l['status'] ?? null,
          dueDate: l['dueDate'] ?? null,
          disbursedAt: l['disbursedAt'] ?? null,
          paidAt: l['paidAt'] ?? null,
          createdAt: l['createdAt'] ?? null,
          mlCreditScore: l['mlCreditScore'] ?? null,
          mlDefaultProb: l['mlDefaultProb'] ?? null,
          overdueDetectedAt: l['overdueDetectedAt'] ?? null,
          contractUrl: l['contractUrl'] ?? null,
          receiptUrl: l['receiptUrl'] ?? null,
          statusHistory: l['statusHistory'] ?? [],
        };
      });

      // Client-side employee name filter when employeeQuery is provided
      if (input.employeeQuery) {
        const q = input.employeeQuery.toLowerCase();
        loans = loans.filter(
          (l: Record<string, unknown>) =>
            (l['employeeName'] as string ?? '').toLowerCase().includes(q) ||
            (l['employeeEmail'] as string ?? '').toLowerCase().includes(q)
        );
      }

      const hasMore = loans.length > input.limit;
      if (hasMore) loans.pop();

      return {
        loans,
        hasMore,
        nextCursor: hasMore ? loans[loans.length - 1].id : null,
        total: loans.length,
      };
    })
  )
);
