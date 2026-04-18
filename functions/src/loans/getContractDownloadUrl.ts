import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

const GetContractDownloadUrlSchema = z.object({
  loanId: z.string().min(1),
});

export type GetContractDownloadUrlInput = z.infer<typeof GetContractDownloadUrlSchema>;

export interface GetContractDownloadUrlResult {
  url: string;
  expiresAt: string;
  contractFilename: string;
}

const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const OPS_ROLES = ['ops', 'admin', 'super_admin'];

export const getContractDownloadUrl = onCall(
  { enforceAppCheck: true },
  withAuth<GetContractDownloadUrlInput, GetContractDownloadUrlResult>(
    [],
    async (data, auth) =>
      withErrorHandling(
        {
          functionName: 'getContractDownloadUrl',
          uid: auth.uid,
          loanId: (data as Record<string, unknown>)['loanId'] as string,
        },
        async () => {
          const parsed = GetContractDownloadUrlSchema.safeParse(data);
          if (!parsed.success) {
            throw new HttpsError(
              'invalid-argument',
              parsed.error.issues[0]?.message ?? 'Invalid input'
            );
          }
          const { loanId } = parsed.data;

          const db = getFirestore();
          const loanSnap = await db.collection('loans').doc(loanId).get();
          if (!loanSnap.exists) {
            throw new HttpsError('not-found', 'Loan not found');
          }
          const loan = loanSnap.data()!;

          const isOwnerEmployee =
            loan['employeeUid'] === auth.uid || loan['employeeId'] === auth.uid;
          const isEmployerAdmin =
            auth.role === 'employer_admin' && loan['employerId'] === auth.employerId;
          const isOps = OPS_ROLES.includes(auth.role);

          if (!isOwnerEmployee && !isEmployerAdmin && !isOps) {
            throw new HttpsError(
              'permission-denied',
              'Not authorized to access this contract'
            );
          }

          const bucket = getStorage().bucket();
          const [files] = await bucket.getFiles({
            prefix: `loans/${loanId}/contrato_`,
          });
          if (!files.length) {
            throw new HttpsError('not-found', 'No contract file found for loan');
          }
          files.sort((a, b) => (a.name < b.name ? 1 : -1));
          const latest = files[0];

          const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_MS);
          const [url] = await latest.getSignedUrl({
            action: 'read',
            expires: expiresAt,
            version: 'v4',
          });

          logger.info('Contract URL issued', {
            loanId,
            uid: auth.uid,
            role: auth.role,
            filename: latest.name,
            expiresAt: expiresAt.toISOString(),
          });

          return {
            url,
            expiresAt: expiresAt.toISOString(),
            contractFilename: latest.name,
          };
        }
      )
  )
);
