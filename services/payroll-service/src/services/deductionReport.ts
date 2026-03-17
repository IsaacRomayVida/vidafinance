import { stringify } from 'csv-stringify/sync';
import { db, storage } from '../lib/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';

export interface DeductionReportRow {
  employee_rfc: string;
  employee_name: string;
  employee_number: string;
  department: string;
  loan_id: string;
  loan_amount: number;
  loan_total: number;
  deduction_amount: number;
  due_date: string;
  loan_status: string;
  bank_clabe: string;
}

export interface GenerateReportOptions {
  employerId: string;
  generatedBy: string;
  payPeriod?: string;
  batchId?: string;
}

/**
 * Generate a deduction report CSV for all active/overdue loans under an employer.
 * Uploads the CSV to Firebase Storage and creates a deduction_reports doc.
 */
export async function generateDeductionReport(opts: GenerateReportOptions): Promise<{
  reportId: string;
  csvUrl: string;
  totalDeductions: number;
  totalAmount: number;
  rows: DeductionReportRow[];
}> {
  const { employerId, generatedBy, payPeriod, batchId } = opts;

  // Fetch active and overdue loans for this employer
  const loansSnap = await db
    .collection('loans')
    .where('employerId', '==', employerId)
    .where('status', 'in', ['active', 'overdue', 'approved'])
    .get();

  const rows: DeductionReportRow[] = [];

  for (const doc of loansSnap.docs) {
    const loan = doc.data();
    // Look up employee details
    let empRfc = '';
    let empNumber = '';
    let department = '';
    let bankClabe = '';

    try {
      const empDoc = await db.collection('employees').doc(loan['employeeId'] as string).get();
      if (empDoc.exists) {
        const empData = empDoc.data()!;
        empRfc = empData['rfc'] ?? '';
        empNumber = empData['employeeNumber'] ?? '';
        department = empData['department'] ?? '';
        bankClabe = empData['bankClabe'] ?? '';
      }
    } catch (_) {
      // Non-critical — proceed without employee details
    }

    const dueDate = loan['dueDate']
      ? new Date((loan['dueDate'] as FirebaseFirestore.Timestamp).seconds * 1000)
          .toISOString()
          .split('T')[0]
      : '';

    rows.push({
      employee_rfc: empRfc,
      employee_name: (loan['employeeName'] as string) ?? '',
      employee_number: empNumber,
      department,
      loan_id: doc.id,
      loan_amount: (loan['amount'] as number) ?? 0,
      loan_total: (loan['total'] as number) ?? 0,
      deduction_amount: (loan['total'] as number) ?? 0,
      due_date: dueDate,
      loan_status: (loan['status'] as string) ?? '',
      bank_clabe: bankClabe,
    });
  }

  // Generate CSV content
  const csvHeaders = [
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

  const csvRows = rows.map((r) => [
    r.employee_rfc,
    r.employee_name,
    r.employee_number,
    r.department,
    r.loan_id,
    r.loan_amount.toFixed(2),
    r.loan_total.toFixed(2),
    r.deduction_amount.toFixed(2),
    r.due_date,
    r.loan_status,
    r.bank_clabe,
  ]);

  const csvContent = stringify([csvHeaders, ...csvRows]);
  const csvBuffer = Buffer.from('\uFEFF' + csvContent, 'utf-8');

  const reportId = nanoid();
  const period = payPeriod ?? new Date().toISOString().split('T')[0];
  const fileName = `deduction_report_${period}_${reportId}.csv`;
  const storagePath = `deduction_reports/${employerId}/${fileName}`;

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  await file.save(csvBuffer, {
    metadata: { contentType: 'text/csv; charset=utf-8' },
  });
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const totalAmount = rows.reduce((sum, r) => sum + r.deduction_amount, 0);

  await db.collection('deduction_reports').doc(reportId).set({
    employerId,
    generatedBy,
    batchId: batchId ?? null,
    payPeriod: period,
    totalEmployees: rows.length,
    totalDeductions: rows.length,
    totalAmount,
    storagePath,
    csvUrl: signedUrl,
    status: 'ready',
    createdAt: FieldValue.serverTimestamp(),
    readyAt: FieldValue.serverTimestamp(),
  });

  return { reportId, csvUrl: signedUrl, totalDeductions: rows.length, totalAmount, rows };
}
