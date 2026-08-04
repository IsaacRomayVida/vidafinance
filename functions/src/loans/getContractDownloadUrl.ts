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

          // Both sides of this comparison must be a non-empty string before it is
          // allowed to authorize anything.
          //
          // It used to be a bare `loan['employerId'] === auth.employerId`, and
          // both operands are routinely absent. No setCustomUserClaims call site
          // in this repo ever writes an `employerId` claim — approveEmployer,
          // setEmployerClaims and onEmployerDocCreated all write `{ role }` and
          // nothing else — so `auth.employerId` is undefined for every real
          // employer_admin. On a loan document that is ALSO missing `employerId`
          // the check degenerated to `undefined === undefined` and granted every
          // employer_admin in the system a signed URL to that borrower's contract
          // PDF: full name, CURP/RFC, amount, repayment schedule.
          //
          // Deliberately NOT widened to `loan['employerId'] === auth.uid` while
          // fixing this, even though firestore.rules' isEmployerAdminOf() accepts
          // that pair for the loan DOCUMENT. storage.rules gates the contract FILE
          // on `loanDoc(loanId).employerAdminUid` — a separate, explicitly recorded
          // field — so matching on the employer id here would hand out a file the
          // storage layer deliberately withholds. Employer access to contracts is
          // broken end to end today (nothing writes employerAdminUid); repairing it
          // is a product decision about who may read a borrower's signed contract,
          // not a security fix, and is reported rather than made here.
          const loanEmployerId = loan['employerId'];
          const isEmployerAdmin =
            auth.role === 'employer_admin' &&
            typeof loanEmployerId === 'string' &&
            loanEmployerId.length > 0 &&
            loanEmployerId === auth.employerId;

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
