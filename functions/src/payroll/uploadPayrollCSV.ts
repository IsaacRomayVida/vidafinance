import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

interface UploadPayrollCSVData {
  storagePath: string;
  fileName: string;
  source?: 'csv_upload' | 'sftp' | 'email';
}

interface UploadPayrollCSVResult {
  batchId: string;
  status: string;
}

function getQueue(name: string): Queue {
  const redisUrl = process.env['REDIS_URL'] ?? '';
  return new Queue(name, {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
  });
}

export const uploadPayrollCSV = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<UploadPayrollCSVData, UploadPayrollCSVResult>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'uploadPayrollCSV', uid: auth.uid }, async () => {
        const { storagePath, fileName, source = 'csv_upload' } = data;

        if (!storagePath || !fileName) {
          throw new HttpsError('invalid-argument', 'storagePath and fileName are required');
        }

        // Validate the storage path belongs to this employer
        if (!storagePath.startsWith(`payroll_uploads/${auth.uid}/`)) {
          throw new HttpsError(
            'permission-denied',
            'Storage path must be under your employer directory',
          );
        }

        const db = getFirestore();
        const batchId = nanoid();

        await db.collection('payroll_batches').doc(batchId).set({
          employerId: auth.uid,
          uploadedBy: auth.uid,
          fileName,
          source,
          status: 'queued',
          storagePath,
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          processedRows: 0,
          errors: [],
          fieldMapping: {},
          createdAt: FieldValue.serverTimestamp(),
          processedAt: null,
        });

        try {
          const queue = getQueue('vida-payroll');
          await queue.add('process_csv', {
            batchId,
            employerId: auth.uid,
            storagePath,
            fileName,
            source,
          });
          await queue.close();
        } catch (e: unknown) {
          console.warn('[uploadPayrollCSV] Queue unavailable:', (e as Error).message);
        }

        return { batchId, status: 'queued' };
      }),
  ),
);
