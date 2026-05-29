import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'motion/react';
import { doc, getDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db } from '../../lib/firebase';
import { friendlyError } from '../../lib/errors';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { LOAN_PURPOSES, fmt } from './types';

interface LoanModalProps {
  availableCredit: number;
  employerId?: string;
  employerCode?: string;
  savedClabe?: string;
  onClose: () => void;
  onSubmitted: () => void;
}

export function LoanModal({
  availableCredit,
  employerId,
  employerCode: initialEmployerCode,
  savedClabe,
  onClose,
  onSubmitted,
}: LoanModalProps) {
  const { t } = useTranslation();
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose);
  const [amount, setAmount] = useState(1000);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [employerCode, setEmployerCode] = useState(initialEmployerCode || '');
  const [loadingEmployer, setLoadingEmployer] = useState(true);
  const [clabe, setClabe] = useState(savedClabe || '');
  const [editingClabe, setEditingClabe] = useState(!savedClabe);
  const [loanPurpose, setLoanPurpose] = useState('');

  useEffect(() => {
    if (initialEmployerCode) {
      setLoadingEmployer(false);
      return;
    }
    if (!employerId) {
      setLoadingEmployer(false);
      return;
    }
    (async () => {
      try {
        const empDoc = await getDoc(doc(db, 'employers', employerId));
        if (empDoc.exists()) {
          setEmployerCode(empDoc.data().employerCode || '');
        }
      } catch {
        // employer code will be empty, submit will fail with server validation
      } finally {
        setLoadingEmployer(false);
      }
    })();
  }, [employerId, initialEmployerCode]);

  const fee = Math.round(amount * 0.3);
  const total = amount + fee;
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const cat = amount > 0 ? ((Math.pow(1 + fee / amount, 365 / 30) - 1) * 100).toFixed(0) : '0';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (amount > availableCredit) { setError(t('modal_exceed')); return; }
    if (amount < 500) { setError(t('modal_minimum')); return; }
    if (!employerCode) { setError(t('modal_no_employer')); return; }
    if (!/^\d{18}$/.test(clabe)) { setError(t('modal_clabe_invalid')); return; }

    setSubmitting(true);
    try {
      if (auth.currentUser) await auth.currentUser.getIdToken(true);
      const functions = getFunctions();
      const requestLoan = httpsCallable(functions, 'requestLoan');
      await requestLoan({
        amount,
        term: 30,
        bankAccountClabe: clabe,
        employerCode,
        termsAccepted: true,
        ...(loanPurpose ? { loanPurpose } : {}),
      });
      onSubmitted();
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
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
      aria-label={t('modal_request')}
    >
      <motion.div
        ref={dialogRef}
        className="modal"
        style={{ position: 'relative' }}
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

        <h3>{t('modal_request')}</h3>
        <p className="modal-sub">
          {t('modal_available')}: <span className="money">${fmt(availableCredit)}</span> MXN
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="ed-modal-amount">{t('modal_amount')}</label>
            <input
              id="ed-modal-amount"
              type="number"
              min={500}
              max={availableCredit}
              step={100}
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="ed-modal-clabe">{t('modal_clabe_label')}</label>
            {savedClabe && !editingClabe ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, color: 'var(--t1)', fontFamily: 'var(--mono, monospace)' }}>
                  {'****' + savedClabe.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => { setEditingClabe(true); setClabe(''); }}
                  style={{ fontSize: 12, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                >
                  {t('modal_clabe_edit')}
                </button>
              </div>
            ) : (
              <input
                id="ed-modal-clabe"
                type="text"
                inputMode="numeric"
                maxLength={18}
                placeholder={t('modal_clabe_placeholder')}
                value={clabe}
                onChange={(e) => setClabe(e.target.value.replace(/\D/g, '').slice(0, 18))}
                required
              />
            )}
          </div>

          <div className="form-group">
            <label htmlFor="ed-modal-purpose">{t('modal_purpose_label')}</label>
            <select
              id="ed-modal-purpose"
              value={loanPurpose}
              onChange={(e) => setLoanPurpose(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">{t('modal_purpose_none')}</option>
              {LOAN_PURPOSES.map((p) => (
                <option key={p} value={p}>{t(`modal_purpose_${p}`)}</option>
              ))}
            </select>
          </div>

          <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_term')}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{t('modal_term_30')} · {t('modal_rate')}</span>
          </div>

          <div style={{ borderTop: '1px solid rgba(25,68,69,0.06)', borderBottom: '1px solid rgba(25,68,69,0.06)', padding: '20px 0', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
              <span className="money" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(amount)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_fee')}</span>
              <span className="money" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(fee)}</span>
            </div>
            <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>{t('modal_total')}</span>
              <span className="money" style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>${fmt(total)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{dueDate.toLocaleDateString('es-MX')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_cat_label')}</span>
              <span className="cat-highlight">{cat}{t('modal_cat_annual')}</span>
            </div>
            <p className="cat-note">
              {t('modal_cat_note')}{' '}
              <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">{t('modal_cat_condusef')}</a>
            </p>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, cursor: 'pointer', fontSize: 13, color: 'var(--t2)' }}>
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <span>{t('modal_accept_terms')}</span>
          </label>

          {error && (
            <div className="auth-error show" style={{ marginBottom: 12 }}>{error}</div>
          )}

          <button
            type="submit"
            disabled={!termsAccepted || submitting || loadingEmployer}
            className="btn-primary"
          >
            {submitting ? (
              <><span className="spinner" />{t('modal_submitting')}</>
            ) : (
              t('modal_confirm')
            )}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
