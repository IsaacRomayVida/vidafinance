import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';

interface DownloadDeductionReportData {
  reportId: string;
}

interface DownloadDeductionReportResult {
  csvUrl: string;
  reportId: string;
  payPeriod: string;
  totalDeductions: number;
  totalAmount: number;
}

export const downloadDeductionReport = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<DownloadDeductionReportData, DownloadDeductionReportResult>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'downloadDeductionReport', uid: auth.uid }, async () => {
        const { reportId } = data;
        if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required');

        const db = getFirestore();
        const doc = await db.collection('deduction_reports').doc(reportId).get();

        if (!doc.exists) {
          throw new HttpsError('not-found', 'Reporte no encontrado');
        }

        const report = doc.data()!;

        if (report['employerId'] !== auth.uid) {
          throw new HttpsError('permission-denied', 'No tienes acceso a este reporte');
        }

        if (report['status'] !== 'ready') {
          throw new HttpsError('failed-precondition', 'El reporte aún no está listo');
        }

        // Refresh the signed URL (original may have expired)
        const storagePath = report['storagePath'] as string;
        const bucket = getStorage().bucket();
        const file = bucket.file(storagePath);

        const [exists] = await file.exists();
        if (!exists) {
          throw new HttpsError('not-found', 'Archivo de reporte no encontrado en Storage');
        }

        const [freshUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 60 * 60 * 1000,
        });

        return {
          csvUrl: freshUrl,
          reportId,
          payPeriod: (report['payPeriod'] as string) ?? '',
          totalDeductions: (report['totalDeductions'] as number) ?? 0,
          totalAmount: (report['totalAmount'] as number) ?? 0,
        };
      }),
  ),
);
