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
    <div className="ops-page">
      <div className="ops-head">
        <div>
          <div className="dot ops-eyebrow">{t('ops_eyebrow_payroll')}</div>
          <h1 className="ops-title">{t('ded_title', 'Deducciones de Nómina')}</h1>
          <p className="ops-sub">{t('ded_subtitle', 'Pagos de préstamos deducidos de la nómina del empleado.')}</p>
        </div>
        {loans.length > 0 && (
          <button type="button" onClick={() => exportToCsv(groups)} className="ops-go" style={{ marginTop: 0 }}>
            <i aria-hidden="true" />{t('ded_export_csv', 'Exportar CSV')}
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="ops-kpis" style={{ marginTop: 0, marginBottom: 10 }}>
        <div className="ops-kpi">
          <small>{t('ded_total_deductions', 'Total Deducciones')}</small>
          <b>${fmt(totalDeductions)}<span>MXN</span></b>
        </div>
        <div className="ops-kpi">
          <small>{t('ded_active_deductions', 'Activos')}</small>
          <b>{activeCount}</b>
        </div>
        <div className="ops-kpi">
          <small>{t('ded_completed', 'Completados')}</small>
          <b>{completedCount}</b>
        </div>
      </div>

      {/* Grouped tables */}
      {error ? (
        <div className="ops-card"><div className="ops-error">{error}</div></div>
      ) : loading ? (
        <div className="ops-card" style={{ textAlign: 'center', padding: 40 }} aria-busy="true">
          <span className="spinner" />
        </div>
      ) : loans.length === 0 ? (
        <div className="ops-card">
          <div className="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <p>{t('ded_empty', 'No hay reportes de deducción disponibles.')}</p>
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <section className="ops-card" key={group.key} aria-label={group.label}>
            <div className="ops-card-head">
              <h2 className="ops-h3">{group.label}</h2>
              <span className="ops-status">Total · ${fmt(group.total)} MXN</span>
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
                      <td style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
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
                      <td style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'rgba(242,245,240,.75)' }}>
                        {loan.softcreditoDeductionId || '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
