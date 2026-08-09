import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { DEDUCTION_REPORT_STATUSES, isActiveDeductionStatus, isRepaidStatus } from '../lib/loanStatus';

import {
  type Loan,
  type PeriodGroup,
  fmt,
  fmtCurrency,
  getDeductionAmount,
  getPayFrequency,
  buildCsv,
  groupByPeriod,
} from '../lib/deductionReport';

function exportToCsv(groups: PeriodGroup[]) {
  const blob = new Blob(['\uFEFF' + buildCsv(groups)], { type: 'text/csv;charset=utf-8;' });
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
  const [error, setError] = useState<string | null>(null);

  // Real-time loans listener — every status with a live or completed deduction
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'loans'),
      where('employerId', '==', user.uid),
      where('status', 'in', DEDUCTION_REPORT_STATUSES as string[]),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
        setLoans(data);
        setLoading(false);
        setError(null);
      },
      (listenError) => {
        console.error('Firestore listen error:', listenError);
        setLoading(false);
        setError('Error al cargar los datos. Intenta de nuevo.');
      },
    );

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
      {error ? (
        <div className="text-red-600" style={{ marginTop: 24 }}>{error}</div>
      ) : loading ? (
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
                    const frequency = getPayFrequency(loan);
                    return (
                    <tr key={loan.id}>
                      <td style={{ fontWeight: 500 }}>{loan.employeeName || '—'}</td>
                      <td style={{ fontWeight: 600, color: 'var(--brand)' }}>
                        {amount === null ? '—' : `$${fmtCurrency(amount)}`}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>
                        {frequency ? t(`freq_${frequency}`, frequency) : '—'}
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
