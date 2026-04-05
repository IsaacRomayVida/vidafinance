import { useState, useEffect, useMemo, useCallback } from 'react';
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
  label: string;       // e.g. "2026-03"
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

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

/* ────────────────────────── component ────────────────────────── */

const ACTIVE_STATUSES = new Set(['approved', 'disbursed', 'disbursement_queued']);

export function AnalyticsPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [employeesReady, setEmployeesReady] = useState(false);
  const [loansReady, setLoansReady] = useState(false);

  const loading = !employeesReady || !loansReady;

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
      buckets[key] = { label: monthLabel(key), count: 0, volume: 0 };
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
  }, [loans]);

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

  /* ────────────────────── styles ────────────────────── */

  const cardStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 20,
    padding: '28px',
    border: '1px solid rgba(25,68,69,0.04)',
    boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '2.2px',
    color: '#a28657',
    marginBottom: 10,
  };

  const valueStyle: React.CSSProperties = {
    fontFamily: "'DM Serif Display',Georgia,serif",
    fontSize: 36,
    color: '#0c1e1f',
    letterSpacing: '-0.03em',
    fontWeight: 400,
    lineHeight: 1,
  };

  const subValueStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#93aaa9',
    marginTop: 6,
  };

  const thStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
    color: '#93aaa9',
  };

  /* ────────────────────── render ────────────────────── */

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', padding: '48px 0 64px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 40 }}>
        <div>
          <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: '#0c1e1f', fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1.15, marginBottom: 8 }}>
            Employer Analytics
          </h1>
          <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7 }}>
            Workforce loan metrics and monthly trends.
          </p>
        </div>
        {!loading && loans.length > 0 && (
          <button
            onClick={downloadCSV}
            style={{
              background: '#194445',
              color: '#fff',
              borderRadius: 60,
              padding: '10px 22px',
              fontSize: 12,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              letterSpacing: '0.2px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            Download CSV
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '64px 24px', color: '#93aaa9' }}>
          <p style={{ fontSize: 14 }}>Loading analytics...</p>
        </div>
      )}

      {/* Main content */}
      {!loading && (
        <>
          {/* KPI cards — 2×3 grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 32 }}>
            <div style={cardStyle}>
              <div style={labelStyle}>Total Employees</div>
              <div style={valueStyle}>{fmt(totalEmployees)}</div>
              <div style={subValueStyle}>Registered in your company</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Active Loans</div>
              <div style={valueStyle}>{fmt(activeLoanCount)}</div>
              <div style={subValueStyle}>{fmtCurrency(activeLoanAmount)} MXN outstanding</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Repayment Rate</div>
              <div style={valueStyle}>{repaymentRate}</div>
              <div style={subValueStyle}>Loans paid on time</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Avg Loan Size</div>
              <div style={valueStyle}>{fmtCurrency(avgLoanSize)}</div>
              <div style={subValueStyle}>MXN per loan</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Utilization Rate</div>
              <div style={valueStyle}>{utilizationRate}</div>
              <div style={subValueStyle}>Employees with a loan</div>
            </div>
            <div style={cardStyle}>
              <div style={labelStyle}>Total Loans</div>
              <div style={valueStyle}>{fmt(loans.length)}</div>
              <div style={subValueStyle}>All time</div>
            </div>
          </div>

          {/* Monthly volume trend — bar chart + table */}
          <div style={{ ...cardStyle, padding: '32px 28px', marginBottom: 20 }}>
            <div style={{ ...labelStyle, marginBottom: 24 }}>Monthly Loan Volume (Last 6 Months)</div>

            {/* Horizontal bar chart */}
            {monthlyTrend.map((m) => (
              <div key={m.label} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#0c1e1f' }}>{m.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#4a6364' }}>
                    {m.count} loan{m.count !== 1 ? 's' : ''} · {fmtCurrency(m.volume)}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'rgba(25,68,69,0.04)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(m.volume / maxMonthlyVolume) * 100}%`,
                      borderRadius: 4,
                      background: '#a28657',
                      transition: 'width 0.4s ease',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Monthly volume table */}
          <div style={{ ...cardStyle, padding: '32px 28px' }}>
            <div style={{ ...labelStyle, marginBottom: 20 }}>Monthly Breakdown</div>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 120px', gap: 12, paddingBottom: 12, borderBottom: '1px solid rgba(25,68,69,0.06)' }}>
              <div style={thStyle}>Month</div>
              <div style={{ ...thStyle, textAlign: 'right' }}>Loans</div>
              <div style={{ ...thStyle, textAlign: 'right' }}>Volume (MXN)</div>
            </div>
            {/* Rows */}
            {monthlyTrend.map((m, i) => (
              <div
                key={m.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 80px 120px',
                  gap: 12,
                  padding: '14px 0',
                  borderBottom: i < monthlyTrend.length - 1 ? '1px solid rgba(25,68,69,0.04)' : 'none',
                  alignItems: 'center',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500, color: '#0c1e1f' }}>{m.label}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#4a6364', textAlign: 'right' }}>{fmt(m.count)}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0c1e1f', textAlign: 'right', fontFamily: "'DM Serif Display',Georgia,serif" }}>
                  {fmtCurrency(m.volume)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
