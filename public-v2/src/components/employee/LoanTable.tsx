import { useTranslation } from 'react-i18next';
import type { Loan, Repayment } from './types';
import { fmt } from './types';
import { SkeletonRows } from '../ui/SkeletonLine';

interface LoanTableProps {
  loans: Loan[];
  repaymentsByLoan: Record<string, Repayment[]>;
  loading: boolean;
  onOpenModal: () => void;
  onPayLoan: (loan: Loan) => void;
}

export function LoanTable({ loans, repaymentsByLoan, loading, onOpenModal, onPayLoan }: LoanTableProps) {
  const { t } = useTranslation();

  return (
    <div className="card">
      <div className="card-title">{t('dash_your_loans')}</div>

      {loading ? (
        <div style={{ padding: 16 }}>
          <SkeletonRows rows={2} />
        </div>
      ) : loans.length === 0 ? (
        <div className="empty-state" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#93aaa9" strokeWidth="1" style={{ marginBottom: 16 }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
          </svg>
          <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', marginBottom: 8, fontWeight: 400 }}>
            {t('dash_no_loans_title', 'Aún no tienes préstamos')}
          </h3>
          <p style={{ fontSize: 14, color: 'var(--t3)', marginBottom: 24, maxWidth: 300, margin: '0 auto 24px' }}>
            {t('dash_no_loans_employee', 'Tu crédito está listo. Solicita fondos en segundos y los recibes en 24 horas.')}
          </p>
          <button
            onClick={onOpenModal}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 4 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            {t('dash_request_first_loan', 'Solicitar tu primer préstamo')}
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('dash_th_amount')}</th>
                <th>{t('dash_th_term')}</th>
                <th>{t('dash_th_repayment')}</th>
                <th>{t('dash_th_status')}</th>
                <th>{t('dash_th_date')}</th>
                <th>{t('dash_th_action')}</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((loan) => {
                const loanRepayments = repaymentsByLoan[loan.id] || [];
                const hasPending = loanRepayments.some((r) => r.status === 'pending');
                const hasProcessing = loanRepayments.some((r) => r.status === 'processing');
                const totalPaid = loanRepayments
                  .filter((r) => r.status === 'completed')
                  .reduce((sum, r) => sum + (r.amount || 0), 0);

                return (
                  <tr key={loan.id}>
                    <td className="money" style={{ fontWeight: 500 }}>${fmt(loan.amount)}</td>
                    <td>{loan.term ?? 30} {t('dash_days')}</td>
                    <td className="money">${fmt(loan.repaymentAmount || loan.total || 0)}</td>
                    <td>
                      <span className={`badge badge-${loan.status}`}>
                        {t(`status_${loan.status}`, loan.status)}
                      </span>
                      {hasPending && (
                        <span className="badge badge-pending" style={{ marginLeft: 4, fontSize: 10 }}>
                          {t('pay_status_pending', 'Pending')}
                        </span>
                      )}
                      {hasProcessing && (
                        <span className="badge badge-approved" style={{ marginLeft: 4, fontSize: 10 }}>
                          {t('pay_status_processing', 'Processing')}
                        </span>
                      )}
                      {totalPaid > 0 && !hasPending && !hasProcessing && (
                        <span className="badge badge-repaid" style={{ marginLeft: 4, fontSize: 10 }}>
                          {t('pay_status_paid', 'Paid')}
                        </span>
                      )}
                    </td>
                    <td>
                      {loan.createdAt ? new Date(loan.createdAt.seconds * 1000).toLocaleDateString('es-MX') : '—'}
                    </td>
                    <td>
                      {['active', 'overdue', 'disbursed'].includes(loan.status) ? (
                        <button
                          onClick={() => onPayLoan(loan)}
                          className="btn-sm btn-approve"
                        >
                          {t('dash_pay_now')}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
