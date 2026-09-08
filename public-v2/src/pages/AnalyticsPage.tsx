import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

/* ────────────────────────── types ────────────────────────── */

interface Employee {
  id: string;
  [key: string]: unknown;
}

interface Loan {
  id: string;
  employeeId?: string;
  amount?: number;
  status?: string;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  paidAt?: { seconds: number };
  [key: string]: unknown;
}

interface MonthBucket {
  label: string;       // e.g. "mar 2026"
  count: number;
  volume: number;
}

/* ────────────────────────── helpers ────────────────────────── */

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtCurrency(n: number): string {
  return '$' + fmt(n);
}

function monthKey(ts: { seconds: number }): string {
  const d = new Date(ts.seconds * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string, lang: string): string {
  const [y, m] = key.split('-');
  return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
    .toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', year: 'numeric' })
    .replace('.', '');
}

/* ────────────────────────── component ────────────────────────── */

const ACTIVE_STATUSES = new Set(['approved', 'disbursed', 'disbursement_queued']);

export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [employeesReady, setEmployeesReady] = useState(false);
  const [loansReady, setLoansReady] = useState(false);

  const loading = !employeesReady || !loansReady;
  const lang = i18n.language;

  /* ── real-time employee listener ── */
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'employees'), where('employerId', '==', user.uid));
    const unsub = onSnapshot(q, (snap) => {
      setEmployees(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Employee)));
      setEmployeesReady(true);
    });
    return unsub;
  }, [user]);

  /* ── real-time loan listener ── */
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'loans'), where('employerId', '==', user.uid));
    const unsub = onSnapshot(q, (snap) => {
      setLoans(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan)));
      setLoansReady(true);
    });
    return unsub;
  }, [user]);

  /* ────────────────────── derived metrics ────────────────────── */

  const totalEmployees = employees.length;

  const activeLoans = useMemo(() => loans.filter((l) => ACTIVE_STATUSES.has(l.status ?? '')), [loans]);
  const activeLoanCount = activeLoans.length;
  const activeLoanAmount = useMemo(
    () => activeLoans.reduce((sum, l) => sum + (Number(l.amount) || 0), 0),
    [activeLoans],
  );

  const avgLoanSize = loans.length > 0
    ? loans.reduce((sum, l) => sum + (Number(l.amount) || 0), 0) / loans.length
    : 0;

  /* repayment rate: % of loans with dueDate that were paid on time */
  const repaymentRate = useMemo(() => {
    const withDue = loans.filter((l) => l.dueDate);
    if (withDue.length === 0) return '–';
    const onTime = withDue.filter((l) => {
      if (!l.paidAt || !l.dueDate) return false;
      return l.paidAt.seconds <= l.dueDate.seconds;
    });
    return ((onTime.length / withDue.length) * 100).toFixed(1) + '%';
  }, [loans]);

  /* utilization rate: % of employees who have at least one loan */
  const utilizationRate = useMemo(() => {
    if (totalEmployees === 0) return '–';
    const employeesWithLoans = new Set(loans.map((l) => l.employeeId).filter(Boolean));
    return ((employeesWithLoans.size / totalEmployees) * 100).toFixed(1) + '%';
  }, [loans, totalEmployees]);

  /* monthly volume trend — last 6 months */
  const monthlyTrend = useMemo(() => {
    const buckets: Record<string, MonthBucket> = {};
    // seed the last 6 months so we always show them
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets[key] = { label: monthLabel(key, lang), count: 0, volume: 0 };
    }
    // fill from loan data
    for (const l of loans) {
      if (!l.createdAt) continue;
      const key = monthKey(l.createdAt);
      if (buckets[key]) {
        buckets[key].count += 1;
        buckets[key].volume += Number(l.amount) || 0;
      }
    }
    return Object.values(buckets);
  }, [loans, lang]);

  const maxMonthlyVolume = useMemo(
    () => Math.max(...monthlyTrend.map((m) => m.volume), 1),
    [monthlyTrend],
  );

  /* ────────────────────── CSV download ────────────────────── */

  const downloadCSV = useCallback(() => {
    const header = ['Loan ID', 'Employee ID', 'Amount (MXN)', 'Status', 'Created', 'Due Date', 'Paid At'];
    const rows = loans.map((l) => [
      l.id,
      l.employeeId ?? '',
      String(Number(l.amount) || 0),
      l.status ?? '',
      l.createdAt ? new Date(l.createdAt.seconds * 1000).toISOString() : '',
      l.dueDate ? new Date(l.dueDate.seconds * 1000).toISOString() : '',
      l.paidAt ? new Date(l.paidAt.seconds * 1000).toISOString() : '',
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loans_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [loans]);

  /* ────────────────────── render ────────────────────── */

  const kpis: { label: string; value: string; sub: string }[] = [
    { label: t('analytics_total_employees'), value: fmt(totalEmployees), sub: t('analytics_total_employees_sub') },
    { label: t('analytics_active_loans'), value: fmt(activeLoanCount), sub: t('analytics_active_loans_sub', { amount: fmtCurrency(activeLoanAmount) }) },
    { label: t('analytics_repayment_rate'), value: repaymentRate, sub: t('analytics_repayment_rate_sub') },
    { label: t('analytics_avg_loan'), value: fmtCurrency(avgLoanSize), sub: t('analytics_avg_loan_sub') },
    { label: t('analytics_utilization'), value: utilizationRate, sub: t('analytics_utilization_sub') },
    { label: t('analytics_total_loans'), value: fmt(loans.length), sub: t('analytics_total_loans_sub') },
  ];

  return (
    <div className="ops-page">
      {/* Header */}
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')}</div>
          <h1 className="ops-title">{t('analytics_title')}</h1>
          <p className="ops-sub">{t('analytics_subtitle')}</p>
        </div>
        {!loading && loans.length > 0 && (
          <button type="button" onClick={downloadCSV} className="ops-go" style={{ marginTop: 0 }}>
            <i aria-hidden="true" />{t('analytics_download_csv')}
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="ops-card" style={{ textAlign: 'center', padding: 48 }} aria-busy="true">
          <p className="ops-note">{t('analytics_loading')}</p>
        </div>
      )}

      {/* Main content */}
      {!loading && (
        <>
          {/* KPI tiles */}
          <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
            {kpis.map((k) => (
              <div className="ops-kpi" key={k.label}>
                <small>{k.label}</small>
                <b>{k.value}</b>
                <em>{k.sub}</em>
              </div>
            ))}
          </div>

          {/* Monthly volume trend */}
          <section className="ops-card">
            <h2 className="ops-h3">{t('analytics_monthly_volume')}</h2>
            {monthlyTrend.map((m) => (
              <div key={m.label} className="ops-bar-row">
                <div className="ops-bar-meta">
                  <span>{m.label}</span>
                  <span>{t('analytics_month_line', { count: m.count, amount: fmtCurrency(m.volume) })}</span>
                </div>
                <div className="ops-bar" aria-hidden="true">
                  <i style={{ width: `${(m.volume / maxMonthlyVolume) * 100}%` }} />
                </div>
              </div>
            ))}
          </section>

          {/* Monthly breakdown */}
          <section className="ops-card">
            <h2 className="ops-h3">{t('analytics_breakdown')}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('analytics_col_month')}</th>
                    <th className="num">{t('analytics_col_loans')}</th>
                    <th className="num">{t('analytics_col_volume')}</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyTrend.map((m) => (
                    <tr key={m.label}>
                      <td style={{ fontWeight: 500 }}>{m.label}</td>
                      <td className="num">{fmt(m.count)}</td>
                      <td className="num">{fmtCurrency(m.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
