import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'motion/react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { classifyError, friendlyError } from '../../lib/errors';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { Loan, Repayment } from './types';
import { fmt } from './types';

interface PaymentModalProps {
  loan: Loan;
  repayments: Repayment[];
  onClose: () => void;
}

export function PaymentModal({ loan, repayments, onClose }: PaymentModalProps) {
  const { t } = useTranslation();
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
        return <span className="badge badge-repaid">{t('pay_status_paid', 'Paid')}</span>;
      case 'processing':
        return <span className="badge badge-approved">{t('pay_status_processing', 'Processing')}</span>;
      default:
        return <span className="badge badge-pending">{t('pay_status_pending', 'Pending')}</span>;
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

  return (
    <div
      className="modal-overlay show"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t('pay_modal_title', 'Make a Payment')}
    >
      <motion.div
        ref={dialogRef}
        className="modal"
        style={{ position: 'relative', maxWidth: 480 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        {...modalVariants}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t('a11y_close')}
          onClick={onClose}
        >
          ✕
        </button>

        <h3>{t('pay_modal_title', 'Make a Payment')}</h3>
        <p className="modal-sub" style={{ marginBottom: 20 }}>
          {t('pay_modal_subtitle', 'Loan')} · <span className="money">${fmt(loan.amount)}</span> MXN
        </p>

        {/* Payment summary */}
        <div style={{
          borderTop: '1px solid rgba(25,68,69,0.06)',
          borderBottom: '1px solid rgba(25,68,69,0.06)',
          padding: '20px 0',
          marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('pay_total_owed', 'Total Owed')}</span>
            <span className="money" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(totalOwed)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('pay_total_paid', 'Total Paid')}</span>
            <span className="money" style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)' }}>${fmt(totalPaid)}</span>
          </div>
          <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
            <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>
              {t('pay_remaining', 'Remaining Balance')}
            </span>
            <span className="money" style={{ fontFamily: 'var(--df)', fontSize: 18, color: remaining > 0 ? 'var(--t1)' : 'var(--success)' }}>
              ${fmt(remaining)}
            </span>
          </div>
          {loan.dueDate && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: loan.status === 'overdue' ? 'var(--danger)' : 'var(--t1)' }}>
                {new Date(loan.dueDate.seconds * 1000).toLocaleDateString('es-MX')}
              </span>
            </div>
          )}
        </div>

        {/* Payment action */}
        {!paymentUrl ? (
          <>
            {error && (
              <div className="auth-error show" style={{ marginBottom: 12 }}>{error}</div>
            )}
            <button
              onClick={handleGenerateLink}
              disabled={loading}
              className="btn-primary"
            >
              {loading ? (
                <><span className="spinner" /> {t('pay_generating', 'Generating link...')}</>
              ) : (
                t('pay_generate_link', 'Generate Payment Link')
              )}
            </button>
          </>
        ) : (
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ background: 'var(--bg2)', borderRadius: 12, padding: '20px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--gold)', marginBottom: 10 }}>
                {t('pay_checkout_ready', 'Checkout Ready')}
              </div>
              <p style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16 }}>
                {t('pay_checkout_desc', 'Click below to complete your payment via Conekta.')}
              </p>
              <a
                href={paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary"
                style={{ display: 'inline-block', textDecoration: 'none', textAlign: 'center' }}
              >
                {t('pay_open_checkout', 'Open Checkout')}
              </a>
            </div>
            <button
              onClick={() => { setPaymentUrl(''); setError(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--t3)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('pay_generate_new', 'Generate new link')}
            </button>
          </div>
        )}

        {/* Payment history */}
        {sortedRepayments.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 2.2, color: 'var(--gold)', marginBottom: 12,
            }}>
              {t('pay_history', 'Payment History')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sortedRepayments.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 14px', background: 'var(--bg2)', borderRadius: 10,
                    border: '1px solid rgba(25,68,69,0.04)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="money" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>
                      ${fmt(r.amount)}
                    </span>
                    {statusBadge(r.status)}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: 'var(--t3)' }}>
                      {r.paidAt || r.createdAt
                        ? new Date(((r.paidAt || r.createdAt)!.seconds) * 1000).toLocaleDateString('es-MX')
                        : '—'}
                    </div>
                    {r.method && (
                      <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.method}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
