import { useTranslation } from 'react-i18next';
import type { Loan, Repayment } from './types';
import { fmt, fmtShortDate } from './types';
import { SkeletonRows } from '../ui/SkeletonLine';

interface LoanTableProps {
  loans: Loan[];
  repaymentsByLoan: Record<string, Repayment[]>;
  loading: boolean;
  onOpenModal: () => void;
  onPayLoan: (loan: Loan) => void;
}

/**
 * The credit list under the Home filter pills: one frosted pill row per loan
 * — amount, status, term and date — with the Pagar action on the loans the
 * server will actually take a payment for ('active' | 'overdue' | 'disbursed',
 * mirroring generatePaymentLink.ts).
 */
export function LoanTable({ loans, repaymentsByLoan, loading, onOpenModal, onPayLoan }: LoanTableProps) {
  const { t, i18n } = useTranslation();

  if (loading) {
    return (
      <div className="bo-list" aria-busy="true">
        <SkeletonRows rows={2} />
      </div>
    );
  }

  if (loans.length === 0) {
    return (
      <div className="bo-empty">
        <b style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          {t('dash_no_loans_title', 'Aún no tienes créditos')}
        </b>
        {t('dash_no_loans_employee')}
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={onOpenModal} className="bo-btn light">
            {t('dash_request_first_loan', 'Solicitar tu primer crédito')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ul className="bo-list" aria-label={t('dash_your_loans')}>
      {loans.map((loan) => {
        const loanRepayments = repaymentsByLoan[loan.id] || [];
        const hasPending = loanRepayments.some((r) => r.status === 'pending');
        const hasProcessing = loanRepayments.some((r) => r.status === 'processing');
        const totalPaid = loanRepayments
          .filter((r) => r.status === 'completed')
          .reduce((sum, r) => sum + (r.amount || 0), 0);
        const when = fmtShortDate(loan.createdAt, i18n.language);

        return (
          <li key={loan.id} className="bo-row">
            <span className="amt money">${fmt(loan.amount)}</span>
            <span className="sub">
              <span className={`bo-badge ${loan.status}`}>{t(`status_${loan.status}`, loan.status)}</span>
              {hasPending && (
                <span className="bo-badge" style={{ marginLeft: 4 }}>{t('pay_status_pending', 'Pendiente')}</span>
              )}
              {hasProcessing && (
                <span className="bo-badge" style={{ marginLeft: 4 }}>{t('pay_status_processing', 'Procesando')}</span>
              )}
              {totalPaid > 0 && !hasPending && !hasProcessing && (
                <span className="bo-badge paid" style={{ marginLeft: 4 }}>{t('pay_status_paid', 'Pagado')}</span>
              )}
              <small>
                <span>{loan.term ?? 30} {t('dash_days')}</span>
                {' · '}
                <span className="money">{t('dash_th_repayment')} ${fmt(loan.repaymentAmount || loan.total || 0)}</span>
                {when ? ` · ${when}` : ''}
              </small>
            </span>
            <span className="act">
              {['active', 'overdue', 'disbursed'].includes(loan.status) ? (
                <button type="button" onClick={() => onPayLoan(loan)} className="bo-btn light">
                  {t('dash_pay_now')}
                </button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
