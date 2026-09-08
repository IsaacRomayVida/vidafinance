import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'motion/react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { classifyError, friendlyError } from '../../lib/errors';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { Loan, Repayment } from './types';
import { fmt, fmtShortDate } from './types';

interface PaymentModalProps {
  loan: Loan;
  repayments: Repayment[];
  onClose: () => void;
}

/**
 * MONEY PATH. This dialog is re-skinned only: what it calls
 * (`generatePaymentLink`), when, and with what, is unchanged. The one green
 * control on the screen is the action that produces (then opens) the link.
 */
export function PaymentModal({ loan, repayments, onClose }: PaymentModalProps) {
  const { t, i18n } = useTranslation();
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');

  const totalOwed = loan.repaymentAmount || loan.total || 0;
  const totalPaid = repayments
    .filter((r) => r.status === 'completed')
    .reduce((sum, r) => sum + (r.amount || 0), 0);
  const remaining = Math.max(0, totalOwed - totalPaid);

  const sortedRepayments = [...repayments].sort((a, b) => {
    const aTime = (a.paidAt || a.createdAt)?.seconds ?? 0;
    const bTime = (b.paidAt || b.createdAt)?.seconds ?? 0;
    return bTime - aTime;
  });

  const handleGenerateLink = async () => {
    setLoading(true);
    setError('');
    try {
      const functions = getFunctions();
      const genPayLink = httpsCallable<{ loanId: string }, { paymentUrl: string; orderId: string; expiresIn: string }>(
        functions,
        'generatePaymentLink',
      );
      const result = await genPayLink({ loanId: loan.id });
      setPaymentUrl(result.data.paymentUrl);
    } catch (err) {
      const code = classifyError(err);
      setError(code === 'generic' ? t('dash_pay_error') : friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = (status?: string) => {
    switch (status) {
      case 'completed':
        return <span className="bo-badge paid">{t('pay_status_paid', 'Pagado')}</span>;
      case 'processing':
        return <span className="bo-badge">{t('pay_status_processing', 'Procesando')}</span>;
      default:
        return <span className="bo-badge">{t('pay_status_pending', 'Pendiente')}</span>;
    }
  };

  const reduced = useReducedMotion();
  const modalVariants = reduced
    ? {}
    : {
        initial: { opacity: 0, scale: 0.96, y: 12 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.96, y: 8 },
      };

  const dueDate = fmtShortDate(loan.dueDate, i18n.language);

  return (
    <div
      className="bo-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t('pay_modal_title', 'Pagar')}
    >
      <motion.div
        ref={dialogRef}
        className="bo-modal"
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        {...modalVariants}
      >
        <div className="bo-head">
          <span className="dot">{t('pay_modal_title', 'Pagar')}</span>
          <button
            type="button"
            className="bo-close"
            aria-label={t('a11y_close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <h3 className="money">
          {fmt(remaining)}<small>MXN</small>
        </h3>
        <p className="sub">
          {t('pay_modal_subtitle', 'Crédito')} · <span className="money">{fmt(loan.amount)}</span> MXN
        </p>

        {/* Payment summary */}
        <div className="bo-quote">
          <div className="r">
            <span>{t('pay_total_owed', 'Total adeudado')}</span>
            <b className="money">{fmt(totalOwed)}</b>
          </div>
          <div className="r">
            <span>{t('pay_total_paid', 'Total pagado')}</span>
            <b className="money">{fmt(totalPaid)}</b>
          </div>
          <div className="r total">
            <span>{t('pay_remaining', 'Saldo restante')}</span>
            <b className="money">{fmt(remaining)}</b>
          </div>
          {dueDate && (
            <div className="r">
              <span>{t('modal_due_date')}</span>
              <b>
                {loan.status === 'overdue' ? `${t('status_overdue', 'Vencido')} · ` : ''}
                {dueDate}
              </b>
            </div>
          )}
        </div>

        {/* Payment action */}
        {!paymentUrl ? (
          <>
            {error && (
              <div className="bo-err" role="alert">{error}</div>
            )}
            <button
              type="button"
              onClick={handleGenerateLink}
              disabled={loading}
              className="bo-cta full"
            >
              {loading ? (
                <><span className="spinner" aria-hidden="true" /> {t('pay_generating', 'Generando enlace…')}</>
              ) : (
                t('pay_generate_link', 'Generar enlace de pago')
              )}
            </button>
          </>
        ) : (
          <div className="bo-ready">
            <span className="dot">{t('pay_checkout_ready', 'Enlace listo')}</span>
            <p>{t('pay_checkout_desc', 'Abre el enlace para completar tu pago con Conekta.')}</p>
            <a
              href={paymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bo-cta full"
            >
              {t('pay_open_checkout', 'Abrir pago')}
            </a>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => { setPaymentUrl(''); setError(''); }}
                className="bo-btn text"
              >
                {t('pay_generate_new', 'Generar nuevo enlace')}
              </button>
            </div>
          </div>
        )}

        {/* Payment history */}
        {sortedRepayments.length > 0 && (
          <div className="bo-hist">
            <span className="dot">{t('pay_history', 'Historial de pagos')}</span>
            {sortedRepayments.map((r) => (
              <div key={r.id} className="bo-hrow">
                <div className="meta">
                  <span className="money" style={{ fontWeight: 600 }}>${fmt(r.amount)}</span>
                  {statusBadge(r.status)}
                </div>
                <div className="how">
                  <div className="when">{fmtShortDate(r.paidAt || r.createdAt, i18n.language) ?? '—'}</div>
                  {r.method && <div>{r.method}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
}
