import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

interface Loan {
  id: string;
  employeeName?: string;
  amount: number;
  repaymentAmount?: number;
  termDays?: number;
  status: string;
  createdAt?: { seconds: number };
  [key: string]: unknown;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function DeductionReports() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);

  // Real-time loans listener — only active/approved loans have deductions
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
      setLoans(data);
      setLoading(false);
    });

    return unsub;
  }, [user]);

  // Filter to loans that have payroll deductions (active, approved, overdue, paid)
  const deductibleLoans = loans.filter(
    (l) => l.status === 'active' || l.status === 'approved' || l.status === 'disbursement_queued' || l.status === 'overdue' || l.status === 'paid'
  );

  // Summary stats
  const totalDeductions = deductibleLoans.reduce((s, l) => s + (l.repaymentAmount ?? l.amount), 0);
  const activeCount = deductibleLoans.filter((l) => l.status === 'active' || l.status === 'approved' || l.status === 'disbursement_queued').length;
  const completedCount = deductibleLoans.filter((l) => l.status === 'paid').length;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 0 64px' }}>
      <div style={{ marginBottom: 40, padding: '0 4px' }}>
        <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 26, color: "#0c1e1f", fontWeight: 400, letterSpacing: "-0.02em", lineHeight: 1.15, marginBottom: 16 }}>
          {t('ded_title', 'Deducciones de Nomina')}
        </h1>
        <p style={{ fontSize: 14, color: "#4a6364", lineHeight: 1.7 }}>
          {t('ded_subtitle', 'Pagos de prestamos deducidos de la nomina del empleado.')}
        </p>
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">{t('ded_total_deductions', 'Total Deductions')}</div>
          <div className="stat-value">${fmt(totalDeductions)}</div>
          <div className="stat-change">MXN</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('ded_active_deductions', 'Active')}</div>
          <div className="stat-value">{activeCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{t('ded_completed', 'Completed')}</div>
          <div className="stat-value">{completedCount}</div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-title">{t('ded_table_title', 'Deduction Schedule')}</div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <span className="spinner" style={{ borderColor: 'rgba(25,68,69,0.1)', borderTopColor: 'var(--brand)' }} />
          </div>
        ) : deductibleLoans.length === 0 ? (
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p>{t('ded_empty', 'No deduction reports available.')}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('dash_th_employee', 'Employee')}</th>
                  <th>{t('ded_th_loan_amount', 'Loan Amount')}</th>
                  <th>{t('ded_th_deduction', 'Deduction')}</th>
                  <th>{t('dash_th_term', 'Term')}</th>
                  <th>{t('dash_th_status', 'Status')}</th>
                  <th>{t('dash_th_date', 'Date')}</th>
                </tr>
              </thead>
              <tbody>
                {deductibleLoans.map((loan) => (
                  <tr key={loan.id}>
                    <td style={{ fontWeight: 500 }}>{loan.employeeName || '—'}</td>
                    <td>${fmt(loan.amount)}</td>
                    <td style={{ fontWeight: 600, color: 'var(--brand)' }}>
                      ${fmt(loan.repaymentAmount ?? loan.amount)}
                    </td>
                    <td>{loan.termDays ?? 30} {t('dash_days', 'days')}</td>
                    <td>
                      <span className={`badge badge-${loan.status}`}>
                        {t(`status_${loan.status}`)}
                      </span>
                    </td>
                    <td>
                      {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
