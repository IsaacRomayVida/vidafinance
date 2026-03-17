import { Worker, Job } from 'bullmq';
import { db, admin } from '../lib/firebase';
import { renderTemplate } from '../services/templateService';
import { renderPDF, uploadPDF } from '../services/pdfService';
import { sendPagareForSigning } from '../services/mifielClient';

export interface PdfJobData {
  type: 'loan_contract' | 'repayment_receipt' | 'deduction_report' | 'portfolio_report';
  loanId?: string;
  employeeId?: string;
  employerId?: string;
  // repayment_receipt fields
  amount?: number;
  chargeId?: string;
  // deduction_report fields
  periodLabel?: string;
  // portfolio_report fields
  month?: string; // YYYY-MM
  // e-signature fields (loan_contract)
  borrowerEmail?: string;
  borrowerRfc?: string;
}

const fmt = (n: number) =>
  Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 });

const QUEUE_NAME = 'vida-pdfs';

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

async function processJob(job: Job<PdfJobData>): Promise<void> {
  const { type, loanId, employeeId, employerId } = job.data;
  console.log(`[pdf-worker] Processing ${type} job ${job.id}`);

  switch (type) {
    case 'loan_contract': {
      if (!loanId) throw new Error('loanId required for loan_contract');
      const loanDoc = await db.collection('loans').doc(loanId).get();
      const loan = loanDoc.data();
      if (!loan) throw new Error(`Loan ${loanId} not found`);

      const cat = (
        (Math.pow(1 + loan.fee / loan.amount, 365 / 30) - 1) * 100
      ).toFixed(0);

      const borrowerEmail = job.data.borrowerEmail || loan.employeeEmail;
      const borrowerRfc = job.data.borrowerRfc || loan.borrowerRfc || null;

      const html = renderTemplate('contract', {
        loanId: loanId.slice(0, 8).toUpperCase(),
        issuedDate: new Date().toLocaleDateString('es-MX'),
        dueDate: loan.dueDate.toDate().toLocaleDateString('es-MX'),
        employeeName: loan.employeeName,
        employerName: loan.employerName,
        amount: fmt(loan.amount),
        fee: fmt(loan.fee),
        total: fmt(loan.total),
        cat,
        borrowerRfc,
        borrowerEmail,
        sofomRfc: process.env.SOFOM_RFC || 'VIDA240101XXX',
        sofomAddress: process.env.SOFOM_ADDRESS || 'Paseo de la Reforma 250 Piso 12, CDMX',
      });

      const pdf = await renderPDF(html);
      const storagePath = `loans/${loanId}/contrato_${Date.now()}.pdf`;
      const url = await uploadPDF(pdf, storagePath);

      await db.collection('loans').doc(loanId).update({
        contractUrl: url,
        contractGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (employeeId) {
        await db.collection('employees').doc(employeeId).collection('documents').add({
          type: 'loan_contract',
          loanId,
          url,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Send contract to Mifiel for e-signature
      if (borrowerEmail) {
        try {
          const mifielResult = await sendPagareForSigning({
            pdfPath: url,
            borrowerName: loan.employeeName,
            borrowerEmail,
            borrowerRfc: borrowerRfc || '',
            loanId,
          });

          await db.collection('loans').doc(loanId).update({
            status: 'pending_signature',
            mifielDocumentId: mifielResult.documentId,
            signingUrl: mifielResult.signingUrl,
            signingExpiresAt: mifielResult.expiresAt,
            signatureSentAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log(`[pdf-worker] Contract sent to Mifiel for loan ${loanId}, docId=${mifielResult.documentId}`);

          // Notify borrower with signing link
          try {
            await db.collection('notifications_queue').add({
              type: 'contract_signing_requested',
              loanId,
              employeeId,
              borrowerEmail,
              signingUrl: mifielResult.signingUrl,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          } catch (notifyErr) {
            console.warn('[pdf-worker] Failed to queue signing notification:', notifyErr);
          }
        } catch (mifielErr) {
          console.error(`[pdf-worker] Mifiel signing failed for loan ${loanId}:`, mifielErr);
          await db.collection('incident_log').add({
            source: 'pdf-worker-mifiel',
            error: mifielErr instanceof Error ? mifielErr.message : String(mifielErr),
            loanId,
            ts: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } else {
        console.warn(`[pdf-worker] No borrower email for loan ${loanId} — skipping Mifiel signing`);
      }
      break;
    }

    case 'repayment_receipt': {
      if (!loanId) throw new Error('loanId required for repayment_receipt');
      const loanDoc = await db.collection('loans').doc(loanId).get();
      const loan = loanDoc.data();
      if (!loan) throw new Error(`Loan ${loanId} not found`);

      const html = renderTemplate('receipt', {
        loanId: loanId.slice(0, 8).toUpperCase(),
        paymentDate: new Date().toLocaleDateString('es-MX'),
        employeeName: loan.employeeName,
        employerName: loan.employerName || '-',
        amount: fmt(job.data.amount ?? loan.total),
        reference: job.data.chargeId || loan.repaymentRef || '-',
        paymentMethod: 'Descuento via nomina',
        sofomRfc: process.env.SOFOM_RFC || 'VIDA240101XXX',
        sofomAddress: process.env.SOFOM_ADDRESS || 'Paseo de la Reforma 250 Piso 12, CDMX',
      });

      const pdf = await renderPDF(html);
      const url = await uploadPDF(pdf, `loans/${loanId}/recibo_${Date.now()}.pdf`);

      await db.collection('loans').doc(loanId).update({
        receiptUrl: url,
        receiptGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }

    case 'deduction_report': {
      if (!employerId) throw new Error('employerId required for deduction_report');

      const employerDoc = await db.collection('employers').doc(employerId).get();
      const employer = employerDoc.data();
      if (!employer) throw new Error(`Employer ${employerId} not found`);

      // Fetch active loans for this employer
      const loansSnap = await db
        .collection('loans')
        .where('employerId', '==', employerId)
        .where('status', '==', 'active')
        .get();

      const deductions: Record<string, unknown>[] = [];
      let totalAmount = 0;

      loansSnap.docs.forEach((doc, idx) => {
        const l = doc.data();
        const deductionAmount = l.total ?? l.amount + (l.fee ?? 0);
        totalAmount += deductionAmount;
        deductions.push({
          rowNum: idx + 1,
          employeeName: l.employeeName,
          employeeNumber: l.employeeNumber || '-',
          loanFolio: doc.id.slice(0, 8).toUpperCase(),
          loanAmount: fmt(l.amount),
          deductionAmount: fmt(deductionAmount),
          remainingBalance: fmt(l.remainingBalance ?? deductionAmount),
          dueDate: l.dueDate?.toDate?.()
            ? l.dueDate.toDate().toLocaleDateString('es-MX')
            : '-',
        });
      });

      const reportId = `DED-${employerId.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

      const html = renderTemplate('deduction-report', {
        employerName: employer.companyName || employer.name,
        employerRfc: employer.rfc || '-',
        periodLabel: job.data.periodLabel || new Date().toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }),
        generatedDate: new Date().toLocaleDateString('es-MX'),
        reportId,
        totalEmployees: deductions.length,
        totalLoans: deductions.length,
        totalAmount: fmt(totalAmount),
        deductions,
        clabe: employer.clabe || process.env.VIDA_CLABE || '-',
        sofomRfc: process.env.SOFOM_RFC || 'VIDA240101XXX',
        sofomAddress: process.env.SOFOM_ADDRESS || 'Paseo de la Reforma 250 Piso 12, CDMX',
      });

      const pdf = await renderPDF(html);
      const url = await uploadPDF(
        pdf,
        `employers/${employerId}/deduction_report_${Date.now()}.pdf`,
      );

      await db.collection('employers').doc(employerId).collection('reports').add({
        type: 'deduction_report',
        url,
        periodLabel: job.data.periodLabel,
        totalAmount,
        employeeCount: deductions.length,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }

    case 'portfolio_report': {
      // Aggregate portfolio data from loans collection
      const allLoansSnap = await db.collection('loans').get();

      let totalPortfolio = 0;
      let activeLoans = 0;
      let currentCount = 0;
      let currentAmount = 0;
      let overdue30Count = 0;
      let overdue30Amount = 0;
      let overdue60Count = 0;
      let overdue60Amount = 0;
      let overdue90Count = 0;
      let overdue90Amount = 0;
      let overdueOver90Count = 0;
      let overdueOver90Amount = 0;
      let monthlyDisbursed = 0;
      let monthlyCollected = 0;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const employerMap = new Map<string, { name: string; active: number; current: number; overdue: number }>();

      for (const doc of allLoansSnap.docs) {
        const l = doc.data();
        const balance = l.remainingBalance ?? l.total ?? l.amount;

        if (l.status === 'active' || l.status === 'overdue') {
          activeLoans++;
          totalPortfolio += balance;

          // Categorize by days overdue
          const dueDate = l.dueDate?.toDate?.() ? l.dueDate.toDate() : null;
          const daysOverdue = dueDate ? Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / 86400000)) : 0;

          if (daysOverdue === 0) {
            currentCount++;
            currentAmount += balance;
          } else if (daysOverdue <= 30) {
            overdue30Count++;
            overdue30Amount += balance;
          } else if (daysOverdue <= 60) {
            overdue60Count++;
            overdue60Amount += balance;
          } else if (daysOverdue <= 90) {
            overdue90Count++;
            overdue90Amount += balance;
          } else {
            overdueOver90Count++;
            overdueOver90Amount += balance;
          }

          // Employer aggregation
          const eid = l.employerId || 'unknown';
          const existing = employerMap.get(eid) || { name: l.employerName || eid, active: 0, current: 0, overdue: 0 };
          existing.active++;
          if (daysOverdue === 0) existing.current += balance;
          else existing.overdue += balance;
          employerMap.set(eid, existing);
        }

        // Monthly disbursements/collections
        const createdAt = l.createdAt?.toDate?.() ? l.createdAt.toDate() : null;
        if (createdAt && createdAt >= monthStart && l.disbursedAmount) {
          monthlyDisbursed += l.disbursedAmount;
        }
        if (l.status === 'paid') {
          const paidAt = l.paidAt?.toDate?.() ? l.paidAt.toDate() : null;
          if (paidAt && paidAt >= monthStart) {
            monthlyCollected += l.total ?? l.amount;
          }
        }
      }

      const delinquencyRate = activeLoans > 0
        ? ((overdue30Count + overdue60Count + overdue90Count + overdueOver90Count) / activeLoans * 100).toFixed(1)
        : '0.0';

      const employers = Array.from(employerMap.entries())
        .sort((a, b) => (b[1].current + b[1].overdue) - (a[1].current + a[1].overdue))
        .slice(0, 20)
        .map((entry, idx) => ({
          rowNum: idx + 1,
          name: entry[1].name,
          activeLoans: entry[1].active,
          currentPortfolio: fmt(entry[1].current),
          overduePortfolio: fmt(entry[1].overdue),
          delinquencyRate: entry[1].active > 0
            ? ((entry[1].overdue > 0 ? 1 : 0) / entry[1].active * 100).toFixed(1)
            : '0.0',
        }));

      const reportId = `PORT-${Date.now().toString(36).toUpperCase()}`;

      const html = renderTemplate('portfolio-report', {
        periodLabel: job.data.month || now.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }),
        generatedDate: now.toLocaleDateString('es-MX'),
        reportId,
        totalPortfolio: fmt(totalPortfolio),
        activeLoans,
        delinquencyRate,
        activeEmployers: employerMap.size,
        monthlyDisbursed: fmt(monthlyDisbursed),
        monthlyCollected: fmt(monthlyCollected),
        currentCount,
        currentAmount: fmt(currentAmount),
        overdue30Count,
        overdue30Amount: fmt(overdue30Amount),
        overdue60Count,
        overdue60Amount: fmt(overdue60Amount),
        overdue90Count,
        overdue90Amount: fmt(overdue90Amount),
        overdueOver90Count,
        overdueOver90Amount: fmt(overdueOver90Amount),
        employers,
        sofomRfc: process.env.SOFOM_RFC || 'VIDA240101XXX',
        sofomAddress: process.env.SOFOM_ADDRESS || 'Paseo de la Reforma 250 Piso 12, CDMX',
      });

      const pdf = await renderPDF(html);
      const url = await uploadPDF(pdf, `reports/portfolio/portfolio_${Date.now()}.pdf`);

      await db.collection('reports').add({
        type: 'portfolio_report',
        url,
        period: job.data.month,
        totalPortfolio,
        activeLoans,
        delinquencyRate: parseFloat(delinquencyRate),
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
    }

    default:
      console.warn(`[pdf-worker] Unknown job type: ${type} (job ${job.id})`);
  }
}

export const pdfWorker = new Worker<PdfJobData>(
  QUEUE_NAME,
  processJob,
  {
    connection: bullConnection,
    concurrency: Number(process.env.MAX_CONCURRENT_PDF_JOBS ?? 2),
  },
);

pdfWorker.on('completed', (job) => {
  console.log(`[pdf-worker] ${job.data.type} job ${job.id} completed`);
});

pdfWorker.on('failed', async (job, err) => {
  console.error(`[pdf-worker] ${job?.data.type} job ${job?.id} failed:`, err.message);
  try {
    await db.collection('incident_log').add({
      source: 'pdf-worker',
      error: err.message,
      jobType: job?.data.type,
      loanId: job?.data.loanId,
      employerId: job?.data.employerId,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (logErr) {
    console.error('[pdf-worker] Failed to log incident:', logErr);
  }
});

// Export for testing
export { processJob };
