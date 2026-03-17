const express = require('express');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const { parse }  = require('csv-parse');
const { stringify } = require('csv-stringify/sync');
const { securityHeaders } = require('../shared/securityHeaders');
const { railwayCors } = require('../shared/cors');
const { requireInternalSecret } = require('../shared/internalAuth');
const { apiRateLimit } = require('../shared/rateLimiter');
require('dotenv').config();

const svcAcct = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
const db    = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});

const app = express();
app.use(securityHeaders);
app.use(railwayCors);
app.use(apiRateLimit);
app.use(express.json({ limit: '10mb' }));

const BATCH_SIZE = 500; // Firestore batch write limit

// ── Field mapping: canonical → possible CSV header names ───────────
const FIELD_MAP = {
  employeeId:    ['employee_id', 'employeeid', 'id_empleado', 'numero_empleado', 'num_empleado', 'worker_id'],
  employeeName:  ['employee_name', 'employeename', 'nombre', 'nombre_empleado', 'name', 'nombre_completo'],
  email:         ['email', 'correo', 'correo_electronico', 'e-mail'],
  curp:          ['curp'],
  rfc:           ['rfc', 'rfc_empleado'],
  monthlySalary: ['monthly_salary', 'monthlysalary', 'salario', 'salario_mensual', 'salary', 'sueldo', 'sueldo_mensual'],
  deductionAmount: ['deduction_amount', 'deductionamount', 'deduccion', 'monto_deduccion', 'descuento', 'monto_descuento'],
  loanId:        ['loan_id', 'loanid', 'id_prestamo', 'prestamo', 'numero_prestamo'],
  bankClabe:     ['clabe', 'bank_clabe', 'bankclabe', 'clabe_interbancaria'],
  payrollPeriod: ['payroll_period', 'payrollperiod', 'periodo', 'periodo_nomina', 'quincena', 'period'],
};

// Normalize a header string for matching
function normalizeHeader(h) {
  return h.trim().toLowerCase().replace(/[\s\-_.]+/g, '_').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Map raw CSV headers to canonical field names
function mapHeaders(rawHeaders) {
  const mapping = {};
  const unmapped = [];
  for (const raw of rawHeaders) {
    const norm = normalizeHeader(raw);
    let found = false;
    for (const [canonical, aliases] of Object.entries(FIELD_MAP)) {
      if (aliases.includes(norm) || canonical.toLowerCase() === norm) {
        mapping[raw] = canonical;
        found = true;
        break;
      }
    }
    if (!found) unmapped.push(raw);
  }
  return { mapping, unmapped };
}

// Validate a single mapped record
function validateRecord(record, idx) {
  const errors = [];
  if (!record.employeeName && !record.employeeId && !record.email) {
    errors.push({ row: idx + 1, field: 'identity', message: 'At least one identifier required (employeeId, employeeName, or email)' });
  }
  if (record.deductionAmount != null) {
    const amt = parseFloat(record.deductionAmount);
    if (isNaN(amt) || amt <= 0) {
      errors.push({ row: idx + 1, field: 'deductionAmount', message: 'Deduction amount must be a positive number' });
    }
  }
  if (record.monthlySalary != null && record.monthlySalary !== '') {
    const sal = parseFloat(record.monthlySalary);
    if (isNaN(sal) || sal <= 0) {
      errors.push({ row: idx + 1, field: 'monthlySalary', message: 'Monthly salary must be a positive number' });
    }
  }
  if (record.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) {
    errors.push({ row: idx + 1, field: 'email', message: 'Invalid email format' });
  }
  if (record.bankClabe && !/^\d{18}$/.test(record.bankClabe)) {
    errors.push({ row: idx + 1, field: 'bankClabe', message: 'CLABE must be 18 digits' });
  }
  return errors;
}

// Parse CSV content → mapped + validated records
function parseAndValidateCSV(csvContent) {
  return new Promise((resolve, reject) => {
    const records = [];
    const allErrors = [];
    const parser = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relaxColumnCount: true,
    });

    let headers = null;
    let headerMapping = null;

    parser.on('readable', function () {
      let raw;
      while ((raw = parser.read()) !== null) {
        if (!headers) {
          headers = Object.keys(raw);
          const { mapping, unmapped } = mapHeaders(headers);
          headerMapping = mapping;
        }
        // Map raw → canonical
        const mapped = {};
        for (const [rawKey, value] of Object.entries(raw)) {
          const canonical = headerMapping[rawKey];
          if (canonical) mapped[canonical] = value;
        }
        const rowErrors = validateRecord(mapped, records.length);
        allErrors.push(...rowErrors);
        records.push(mapped);
      }
    });

    parser.on('error', (err) => reject(err));
    parser.on('end', () => {
      resolve({
        records,
        headers: headers || [],
        headerMapping: headerMapping || {},
        errors: allErrors,
        totalRows: records.length,
        validRows: records.length - new Set(allErrors.map(e => e.row)).size,
      });
    });
  });
}

// Generate deduction report CSV from active loans for an employer
async function generateDeductionReport(employerId, payrollPeriod) {
  const loansSnap = await db.collection('loans')
    .where('employerId', '==', employerId)
    .where('status', 'in', ['active', 'overdue'])
    .get();

  if (loansSnap.empty) return { csv: '', count: 0 };

  const rows = [];
  for (const doc of loansSnap.docs) {
    const loan = doc.data();
    rows.push({
      loan_id: doc.id,
      employee_name: loan.employeeName || '',
      employee_email: loan.employeeEmail || '',
      employee_id: loan.employeeId || '',
      loan_amount: loan.amount || 0,
      total_due: loan.total || 0,
      fee: loan.fee || 0,
      deduction_amount: loan.total || 0,
      due_date: loan.dueDate ? new Date(loan.dueDate.seconds * 1000).toISOString().split('T')[0] : '',
      status: loan.status,
      payroll_period: payrollPeriod || '',
    });
  }

  const csv = stringify(rows, {
    header: true,
    columns: [
      { key: 'loan_id', header: 'ID Préstamo' },
      { key: 'employee_name', header: 'Nombre Empleado' },
      { key: 'employee_email', header: 'Email' },
      { key: 'employee_id', header: 'ID Empleado' },
      { key: 'loan_amount', header: 'Monto Préstamo' },
      { key: 'fee', header: 'Comisión' },
      { key: 'total_due', header: 'Total a Deducir' },
      { key: 'deduction_amount', header: 'Monto Deducción' },
      { key: 'due_date', header: 'Fecha Vencimiento' },
      { key: 'status', header: 'Estado' },
      { key: 'payroll_period', header: 'Periodo Nómina' },
    ],
  });

  return { csv, count: rows.length, rows };
}

// ── Health ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const r = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: r ? 'ok' : 'degraded', service: 'vida-payroll-service', redis: r, ts: new Date().toISOString() });
});

// ── Internal: Process payroll CSV ──────────────────────────────────
app.post('/internal/process-csv', requireInternalSecret, async (req, res) => {
  const { batchId, employerId, csvContent } = req.body;
  if (!batchId || !employerId || !csvContent) {
    return res.status(400).json({ error: 'Missing batchId, employerId, or csvContent' });
  }

  try {
    const result = await parseAndValidateCSV(csvContent);

    // Update batch with parsing results
    await db.collection('payroll_batches').doc(batchId).update({
      status: result.errors.length > 0 ? 'validated_with_errors' : 'validated',
      totalRows: result.totalRows,
      validRows: result.validRows,
      errors: result.errors.slice(0, 100), // cap stored errors
      headerMapping: result.headerMapping,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Store individual payroll records (batches of 500 — Firestore limit)
    for (let start = 0; start < result.records.length; start += BATCH_SIZE) {
      const batch = db.batch();
      const end = Math.min(start + BATCH_SIZE, result.records.length);
      for (let i = start; i < end; i++) {
        const rec = result.records[i];
        const rowHasError = result.errors.some(e => e.row === i + 1);
        const ref = db.collection('payroll_records').doc();
        batch.set(ref, {
          batchId,
          employerId,
          rowIndex: i,
          ...rec,
          deductionAmount: rec.deductionAmount ? parseFloat(rec.deductionAmount) : null,
          monthlySalary: rec.monthlySalary ? parseFloat(rec.monthlySalary) : null,
          valid: !rowHasError,
          status: rowHasError ? 'error' : 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    res.json({
      success: true,
      totalRows: result.totalRows,
      validRows: result.validRows,
      errorCount: result.errors.length,
    });
  } catch (err) {
    await db.collection('payroll_batches').doc(batchId).update({
      status: 'failed',
      error: err.message,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('incident_log').add({
      source: 'payroll-service',
      batchId,
      error: err.message,
      severity: 'warning',
      ts: admin.firestore.FieldValue.serverTimestamp(),
      resolved: false,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── Internal: Generate deduction report ───────────────────────────
app.post('/internal/deduction-report', requireInternalSecret, async (req, res) => {
  const { employerId, payrollPeriod, reportId } = req.body;
  if (!employerId) return res.status(400).json({ error: 'Missing employerId' });

  try {
    const { csv, count, rows } = await generateDeductionReport(employerId, payrollPeriod);

    if (reportId) {
      // Upload CSV to Storage
      const bucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
      const fileName = `payroll/${employerId}/deductions_${payrollPeriod || Date.now()}.csv`;
      const file = bucket.file(fileName);
      await file.save(csv, { contentType: 'text/csv', metadata: { cacheControl: 'private, max-age=3600' } });
      const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });

      await db.collection('deduction_reports').doc(reportId).update({
        status: 'completed',
        downloadUrl: url,
        recordCount: count,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true, csv, count, rows });
  } catch (err) {
    if (reportId) {
      await db.collection('deduction_reports').doc(reportId).update({
        status: 'failed',
        error: err.message,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Internal: SFTP poll ───────────────────────────────────────────
app.post('/internal/sftp-poll', requireInternalSecret, async (req, res) => {
  if (!process.env.SFTP_HOST) {
    return res.json({ success: true, message: 'SFTP not configured, skipping', files: [] });
  }

  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  const processedFiles = [];

  try {
    await sftp.connect({
      host: process.env.SFTP_HOST,
      port: parseInt(process.env.SFTP_PORT || '22'),
      username: process.env.SFTP_USERNAME,
      password: process.env.SFTP_PASSWORD,
      privateKey: process.env.SFTP_PRIVATE_KEY || undefined,
    });

    const remotePath = process.env.SFTP_REMOTE_PATH || '/uploads';
    const files = await sftp.list(remotePath);
    const csvFiles = files.filter(f => f.name.endsWith('.csv') && f.type === '-');

    for (const file of csvFiles) {
      const filePath = `${remotePath}/${file.name}`;
      const content = await sftp.get(filePath);
      const csvContent = content.toString('utf-8');

      // Extract employer ID from filename convention: {employerCode}_payroll_{date}.csv
      const match = file.name.match(/^([A-Z0-9]+)_payroll_/i);
      if (!match) {
        console.warn('SFTP: skipping file with unknown naming convention:', file.name);
        continue;
      }

      const employerCode = match[1].toUpperCase();
      const empSnap = await db.collection('employers')
        .where('employerCode', '==', employerCode)
        .where('status', '==', 'active')
        .limit(1)
        .get();

      if (empSnap.empty) {
        console.warn('SFTP: no active employer for code:', employerCode);
        continue;
      }

      const employerId = empSnap.docs[0].id;
      const batchId = `sftp_${Date.now()}_${file.name.replace('.csv', '')}`;

      await db.collection('payroll_batches').doc(batchId).set({
        employerId,
        source: 'sftp',
        fileName: file.name,
        fileSize: file.size,
        status: 'processing',
        uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Process inline (SFTP files are expected to be small)
      const result = await parseAndValidateCSV(csvContent);

      await db.collection('payroll_batches').doc(batchId).update({
        status: result.errors.length > 0 ? 'validated_with_errors' : 'validated',
        totalRows: result.totalRows,
        validRows: result.validRows,
        errors: result.errors.slice(0, 100),
        headerMapping: result.headerMapping,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Store records (batches of 500 — Firestore limit)
      for (let start = 0; start < result.records.length; start += BATCH_SIZE) {
        const batch = db.batch();
        const end = Math.min(start + BATCH_SIZE, result.records.length);
        for (let i = start; i < end; i++) {
          const rec = result.records[i];
          const rowHasError = result.errors.some(e => e.row === i + 1);
          batch.set(db.collection('payroll_records').doc(), {
            batchId,
            employerId,
            rowIndex: i,
            ...rec,
            deductionAmount: rec.deductionAmount ? parseFloat(rec.deductionAmount) : null,
            monthlySalary: rec.monthlySalary ? parseFloat(rec.monthlySalary) : null,
            valid: !rowHasError,
            status: rowHasError ? 'error' : 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        await batch.commit();
      }

      // Move processed file to archive
      const archivePath = `${remotePath}/processed/${file.name}`;
      try {
        await sftp.mkdir(`${remotePath}/processed`, true);
        await sftp.rename(filePath, archivePath);
      } catch (_) { /* best-effort archive */ }

      processedFiles.push({ fileName: file.name, batchId, totalRows: result.totalRows });
    }

    await sftp.end();
    res.json({ success: true, files: processedFiles });
  } catch (err) {
    try { await sftp.end(); } catch (_) {}
    await db.collection('incident_log').add({
      source: 'payroll-sftp',
      error: err.message,
      severity: 'warning',
      ts: admin.firestore.FieldValue.serverTimestamp(),
      resolved: false,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── BullMQ: payroll processing worker ─────────────────────────────
const payrollWorker = new Worker('vida-payroll', async job => {
  const { batchId, employerId, csvContent, type } = job.data;

  if (type === 'process_csv') {
    const fetch = require('node-fetch');
    // Self-call for processing (keeps worker thin)
    const resp = await fetch(`http://localhost:${process.env.PORT || 3005}/internal/process-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
      body: JSON.stringify({ batchId, employerId, csvContent }),
    });
    if (!resp.ok) throw new Error('CSV processing failed: ' + await resp.text());
    return await resp.json();
  }

  if (type === 'generate_report') {
    const { reportId, payrollPeriod } = job.data;
    const fetch = require('node-fetch');
    const resp = await fetch(`http://localhost:${process.env.PORT || 3005}/internal/deduction-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET },
      body: JSON.stringify({ employerId, payrollPeriod, reportId }),
    });
    if (!resp.ok) throw new Error('Report generation failed: ' + await resp.text());
    return await resp.json();
  }
}, { connection: redis, concurrency: 5 });

payrollWorker.on('failed', async (job, err) => {
  if (job?.attemptsMade >= 5) {
    const { batchId, type, reportId } = job.data;
    if (type === 'process_csv' && batchId) {
      await db.collection('payroll_batches').doc(batchId).update({ status: 'failed', error: err.message });
    }
    if (type === 'generate_report' && reportId) {
      await db.collection('deduction_reports').doc(reportId).update({ status: 'failed', error: err.message });
    }
    await db.collection('incident_log').add({
      source: 'payroll-worker',
      error: err.message,
      jobType: type,
      ts: admin.firestore.FieldValue.serverTimestamp(),
      resolved: false,
    });
  }
});

app.listen(process.env.PORT || 3005, () => console.log('vida-payroll-service on', process.env.PORT || 3005));
