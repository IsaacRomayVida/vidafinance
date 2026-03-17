import { onCall } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { validateInput } from '../utils/validateInput';

const ListUsersSchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(['employee', 'employer_admin', 'ops', 'admin', 'super_admin', 'all']).default('all'),
  limit: z.number().int().min(1).max(100).default(50),
  startAfter: z.string().optional(),
});

export const listUsers = onCall(
  { enforceAppCheck: true },
  withAuth(['admin', 'super_admin'], async (data, auth) =>
    withErrorHandling({ functionName: 'listUsers', uid: auth.uid }, async () => {
      const input = validateInput(ListUsersSchema, data);
      const db = getFirestore();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = db.collection('users').orderBy('updatedAt', 'desc').limit(input.limit);

      if (input.role !== 'all') {
        query = db.collection('users').where('role', '==', input.role).limit(input.limit);
      }

      if (input.startAfter) {
        const cursorDoc = await db.collection('users').doc(input.startAfter).get();
        if (cursorDoc.exists) {
          query = query.startAfter(cursorDoc);
        }
      }

      const snap = await query.get();

      let users = snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => {
        const u = d.data();
        return {
          uid: d.id,
          email: u['email'] ?? null,
          displayName: u['displayName'] ?? u['name'] ?? null,
          role: u['role'] ?? 'employee',
          employerId: u['employerId'] ?? null,
          createdAt: u['createdAt'] ?? null,
          updatedAt: u['updatedAt'] ?? null,
          disabled: u['disabled'] ?? false,
        };
      });

      // Apply search filter client-side
      if (input.search) {
        const s = input.search.toLowerCase();
        users = users.filter(
          (u: Record<string, unknown>) =>
            (u['email'] as string ?? '').toLowerCase().includes(s) ||
            (u['displayName'] as string ?? '').toLowerCase().includes(s) ||
            (u['uid'] as string ?? '').toLowerCase().includes(s)
        );
      }

      // Fetch Auth metadata for users to get emailVerified and lastSignIn
      const enriched = await Promise.allSettled(
        users.slice(0, 50).map(async (u: Record<string, unknown>) => {
          try {
            const authUser = await getAuth().getUser(u['uid'] as string);
            return {
              ...u,
              emailVerified: authUser.emailVerified,
              lastSignInTime: authUser.metadata.lastSignInTime ?? null,
              creationTime: authUser.metadata.creationTime ?? null,
              disabled: authUser.disabled,
            };
          } catch (_) {
            return u;
          }
        })
      );

      const enrichedUsers = enriched.map((r) =>
        r.status === 'fulfilled' ? r.value : null
      ).filter(Boolean);

      const lastId = snap.docs.length === input.limit ? snap.docs[snap.docs.length - 1].id : null;

      // Role distribution counts
      const [adminCount, opsCount, employerAdminCount] = await Promise.all([
        db.collection('users').where('role', '==', 'admin').count().get(),
        db.collection('users').where('role', '==', 'ops').count().get(),
        db.collection('users').where('role', '==', 'employer_admin').count().get(),
      ]);

      return {
        users: enrichedUsers,
        nextCursor: lastId,
        hasMore: lastId !== null,
        roleCounts: {
          admin: adminCount.data().count,
          ops: opsCount.data().count,
          employer_admin: employerAdminCount.data().count,
        },
      };
    })
  )
);
