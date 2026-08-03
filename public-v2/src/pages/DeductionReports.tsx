import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { DEDUCTION_REPORT_STATUSES, isActiveDeductionStatus, isRepaidStatus } from '../lib/loanStatus';

export interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  fee?: number;
  total?: number;
  remainingBalance?: number;
  frequency?: string;
  termDays?: number;
  status: string;
  softcreditoDeductionId?: string;
  createdAt?: { seconds: number };
  [key: string]: unknown;
}

interface PeriodGroup {
  key: string;
  label: string;
  loans: Loan[];
  total: number;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtCurrency(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * What the employer still owes on this loan via payroll deduction.
 *
 * `loan.remainingBalance` is the live outstanding figure once processPayroll
 * has run at least once (functions/src/payroll/processPayroll.ts:125); before
 * that it doesn't exist on the document yet, and the full obligation is
 * `loan.total` (= amount + fee, functions/src/index.ts:838) — never bare
 * `loan.amount`, which is principal only and always understates it. If
 * neither field is present the true obligation is unknown; returning null
 * (rather than silently falling back to `amount`) is what this fixes.
 */
export function getDeductionAmount(loan: Loan): number | null {
  if (typeof loan.remainingBalance === 'number' && Number.isFinite(loan.remainingBalance)) {
    return loan.remainingBalance;
  }
  if (typeof loan.total === 'number' && Number.isFinite(loan.total)) {
    return loan.total;
  }
  return null;
}

function formatDeductionAmount(loan: Loan): string {
  const amount = getDeductionAmount(loan);
  return amount === null ? '—' : fmtCurrency(amount);
}

function getPeriodKey(loan: Loan): string {
  if (!loan.createdAt) return '0000-00';
  const d = new Date(loan.createdAt.seconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getPeriodLabel(key: string): string {
  if (key === '0000-00') return 'Unknown';
  const [y, m] = key.split('-');
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${months[Number(m) - 1]} ${y}`;
}

export function groupByPeriod(loans: Loan[]): PeriodGroup[] {
  const map = new Map<string, Loan[]>();
  for (const loan of loans) {
    const key = getPeriodKey(loan);
    const arr = map.get(key) ?? [];
    arr.push(loan);
    map.set(key, arr);
  }

  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, groupLoans]) => ({
      key,
      label: getPeriodLabel(key),
      loans: groupLoans,
      total: groupLoans.reduce((s, l) => s + (getDeductionAmount(l) ?? 0), 0),
    }));
}

const CSV_HEADERS = ['Period', 'Employee', 'Deduction Amount', 'Frequency', 'Status', 'Deduction ID'];

export function buildCsvRows(groups: PeriodGroup[]): string[][] {
  const rows: string[][] = [];

  for (const group of groups) {
    for (const loan of group.loans) {
      rows.push([
        group.label,
        loan.employeeName ?? '',
        formatDeductionAmount(loan),
        loan.frequency ?? 'monthly',
        loan.status,
        loan.softcreditoDeductionId ?? '',
      ]);
    }
    rows.push([group.label, 'TOTAL', fmtCurrency(group.total), '', '', '']);
  }

  return rows;
}

function exportToCsv(groups: PeriodGroup[]) {
  const rows = buildCsvRows(groups);
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = [CSV_HEADERS, ...rows].map((r) => r.map(escape).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deduction-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DeductionReports() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);

  // Real-time loans listener — every status with a live or completed deduction
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      where('status', 'in', DEDUCTION_REPORT_STATUSES as string[]),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
      setLoans(data);
      setLoading(false);
    });

    return unsub;
  }, [user]);

  const groups = useMemo(() => groupByPeriod(loans), [loans]);

  // Summary stats
  const totalDeductions = loans.reduce((s, l) => s + (getDeductionAmount(l) ?? 0), 0);
  const activeCount = loans.filter((l) => isActiveDeductionStatus(l.status)).length;
  const completedCount = loans.filter((l) => isRepaidStatus(l.status)).length;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 0 64px' }}>
      <div style={{ marginBottom: 40, padding: '0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--df)', fontSize: 26, color: "var(--t1)", fontWeight: 400, letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 16 }}>
            {t('ded_title', 'Deducciones de Nómina')}
          </h1>
          <p style={{ fontSize: 14, color: "var(--t2)", lineHeight: 1.7 }}>
            {t('ded_subtitle', 'Pagos de préstamos deducidos de la nómina del empleado.')}
          </p>
        </div>
        {loans.length > 0 && (
          <button
            onClick={() => exportToCsv(groups)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: 'var(--brand, var(--brand))',
              color: '#fff',
              border: 'none',
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              marginTop: 4,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('ded_export_csv', 'Exportar CSV')}
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">{t('ded_total_deductions', 'Total Deducciones')}</div>
          <div className="stat-value">${fmt(totalDeductions)}</div>
          <div className="stat-change">MXN</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('ded_active_deductions', 'Activos')}</div>
          <div className="stat-value">{activeCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('ded_completed', 'Completados')}</div>
          <div className="stat-value">{completedCount}</div>
        </div>
      </div>

      {/* Grouped tables */}
      {loading ? (
        <div className="card" style={{ marginTop: 24 }}>
          <div style={{ padding: 40, textAlign: 'center' }}>
            <span className="spinner" style={{ borderColor: 'rgba(25,68,69,0.1)', borderTopColor: 'var(--brand)' }} />
          </div>
        </div>
      ) : loans.length === 0 ? (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p>{t('ded_empty', 'No hay reportes de deducción disponibles.')}</p>
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <div className="card" style={{ marginTop: 24 }} key={group.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>{group.label}</div>
              <div style={{
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--gold, var(--gold))',
                background: 'rgba(162,134,87,0.08)',
                padding: '6px 14px',
                borderRadius: 20,
              }}>
                Total: ${fmt(group.total)} MXN
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('dash_th_employee', 'Empleado')}</th>
                    <th>{t('ded_th_deduction', 'Deducción')}</th>
                    <th>{t('ded_th_frequency', 'Frecuencia')}</th>
                    <th>{t('dash_th_status', 'Estatus')}</th>
                    <th>{t('ded_th_deduction_id', 'ID Deducción')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.loans.map((loan) => {
                    const amount = getDeductionAmount(loan);
                    return (
                    <tr key={loan.id}>
                      <td style={{ fontWeight: 500 }}>{loan.employeeName || '—'}</td>
                      <td style={{ fontWeight: 600, color: 'var(--brand)' }}>
                        {amount === null ? '—' : `$${fmtCurrency(amount)}`}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>
                        {t(`freq_${loan.frequency ?? 'monthly'}`, loan.frequency ?? 'monthly')}
                      </td>
                      <td>
                        <span className={`badge badge-${loan.status}`}>
                          {t(`status_${loan.status}`, loan.status)}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--t2)' }}>
                        {loan.softcreditoDeductionId || '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
