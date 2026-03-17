import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { nanoid } from 'nanoid';

interface GenerateDeductionReportData {
  payPeriod?: string;
  batchId?: string;
}

interface GenerateDeductionReportResult {
  reportId: string;
  csvUrl: string;
  totalDeductions: number;
  totalAmount: number;
}

interface DeductionRow {
  employeeRfc: string;
  employeeName: string;
  employeeNumber: string;
  department: string;
  loanId: string;
  loanAmount: number;
  loanTotal: number;
  deductionAmount: number;
  dueDate: string;
  loanStatus: string;
  bankClabe: string;
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildCsvContent(rows: DeductionRow[]): string {
  const headers = [
    'RFC',
    'Nombre del Empleado',
    'No. Empleado',
    'Departamento',
    'ID Préstamo',
    'Monto Préstamo',
    'Total a Pagar',
    'Deducción Nómina',
    'Fecha Límite',
    'Estado',
    'CLABE',
  ];

  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((r) =>
      [
        r.employeeRfc,
        r.employeeName,
        r.employeeNumber,
        r.department,
        r.loanId,
        r.loanAmount.toFixed(2),
        r.loanTotal.toFixed(2),
        r.deductionAmount.toFixed(2),
        r.dueDate,
        r.loanStatus,
        r.bankClabe,
      ]
        .map(String)
        .map(csvEscape)
        .join(','),
    ),
  ];

  return '\uFEFF' + lines.join('\r\n');
}

export const generateDeductionReport = onCall(
  { cors: true, enforceAppCheck: true },
  withAuth<GenerateDeductionReportData, GenerateDeductionReportResult>(
    ['employer_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'generateDeductionReport', uid: auth.uid }, async () => {
        const { payPeriod, batchId } = data;
        const employerId = auth.uid;
        const db = getFirestore();

        const loansSnap = await db
          .collection('loans')
          .where('employerId', '==', employerId)
          .where('status', 'in', ['active', 'overdue', 'approved'])
          .get();

        if (loansSnap.empty) {
          throw new HttpsError('not-found', 'No hay préstamos activos para generar el reporte');
        }

        // Fetch all employees for this employer in one query
        const employeesSnap = await db
          .collection('employees')
          .where('employerId', '==', employerId)
          .get();
        const employeeMap = new Map<string, FirebaseFirestore.DocumentData>();
        for (const doc of employeesSnap.docs) {
          employeeMap.set(doc.id, doc.data());
        }

        const rows: DeductionRow[] = loansSnap.docs.map((doc) => {
          const loan = doc.data();
          const emp = employeeMap.get(loan['employeeId'] as string);

          const dueDate = loan['dueDate']
            ? new Date(
                (loan['dueDate'] as FirebaseFirestore.Timestamp).seconds * 1000,
              )
                .toISOString()
                .split('T')[0]
            : '';

          return {
            employeeRfc: (emp?.['rfc'] as string) ?? '',
            employeeName: (loan['employeeName'] as string) ?? '',
            employeeNumber: (emp?.['employeeNumber'] as string) ?? '',
            department: (emp?.['department'] as string) ?? '',
            loanId: doc.id,
            loanAmount: (loan['amount'] as number) ?? 0,
            loanTotal: (loan['total'] as number) ?? 0,
            deductionAmount: (loan['total'] as number) ?? 0,
            dueDate,
            loanStatus: (loan['status'] as string) ?? '',
            bankClabe: (emp?.['bankClabe'] as string) ?? '',
          };
        });

        const csvContent = buildCsvContent(rows);
        const csvBuffer = Buffer.from(csvContent, 'utf-8');

        const reportId = nanoid();
        const period = payPeriod ?? new Date().toISOString().split('T')[0];
        const fileName = `deduction_report_${period}_${reportId}.csv`;
        const storagePath = `deduction_reports/${employerId}/${fileName}`;

        const bucket = getStorage().bucket();
        const file = bucket.file(storagePath);
        await file.save(csvBuffer, {
          metadata: { contentType: 'text/csv; charset=utf-8' },
        });

        const [csvUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

        const totalAmount = rows.reduce((sum, r) => sum + r.deductionAmount, 0);

        await db.collection('deduction_reports').doc(reportId).set({
          employerId,
          generatedBy: auth.uid,
          batchId: batchId ?? null,
          payPeriod: period,
          totalEmployees: rows.length,
          totalDeductions: rows.length,
          totalAmount,
          storagePath,
          csvUrl,
          status: 'ready',
          createdAt: FieldValue.serverTimestamp(),
          readyAt: FieldValue.serverTimestamp(),
        });

        return { reportId, csvUrl, totalDeductions: rows.length, totalAmount };
      }),
  ),
);
