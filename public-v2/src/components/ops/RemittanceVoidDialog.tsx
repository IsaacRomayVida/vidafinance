import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { friendlyError } from '../../lib/errors';
import { formatCents } from '../../lib/money';
import {
  VOID_REASON_MAX,
  VOID_REASON_MIN,
  classifyRemittanceError,
  voidReasonProblem,
  type Remittance,
  type RemittanceReceipt,
  type VoidReasonProblem,
  type VoidReceiptInput,
  type VoidReceiptResult,
} from '../../lib/remittance';

interface Props {
  remittance: Remittance;
  receipt: RemittanceReceipt;
  onClose: () => void;
  onVoided: (result: VoidReceiptResult) => void;
}

/**
 * Voids one receipt, in two steps: the reason first, then an explicit
 * confirmation that spells out what changes. Nothing is sent until the second
 * step — a void moves money on the ledger and lands in the audit log.
 */
export function RemittanceVoidDialog({ remittance, receipt, onClose, onVoided }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'reason' | 'confirm'>('reason');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<VoidReasonProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const sheetRef = useFocusTrap<HTMLFormElement>(onClose);

  const amount = formatCents(receipt.amountCents);
  const reference = receipt.bankReference ?? t('remit_receipt_no_reference');

  const describe = (err: unknown): string => {
    const kind = classifyRemittanceError(err);
    if (kind.kind === 'invalid') return t('remit_err_invalid', { detail: kind.detail });
    if (kind.kind === 'not_found') return t('remit_err_not_found_void');
    return friendlyError(err);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    if (step === 'reason') {
      const next = voidReasonProblem(reason);
      setProblem(next);
      if (!next) setStep('confirm');
      return;
    }

    setSubmitting(true);
    setServerError(null);
    try {
      const fn = httpsCallable<VoidReceiptInput, VoidReceiptResult>(getFunctions(), 'voidPayrollRemittanceReceipt');
      const result = await fn({ batchId: remittance.batchId, receiptId: receipt.receiptId, reason: reason.trim() });
      onVoided(result.data);
    } catch (err: unknown) {
      setServerError(describe(err));
    } finally {
      setSubmitting(false);
    }
  };

  const reasonError =
    problem === 'required'
      ? t('remit_val_reason_required', { min: VOID_REASON_MIN })
      : problem === 'too_long'
        ? t('remit_val_reason_too_long', { max: VOID_REASON_MAX })
        : null;

  return (
    <div className="ops-overlay" role="dialog" aria-modal="true" aria-labelledby="remit-void-title">
      <form ref={sheetRef} className="ops-card ops-sheet" onSubmit={onSubmit} noValidate>
        <h2 id="remit-void-title" className="ops-h3">
          {step === 'reason' ? t('remit_dialog_void_title') : t('remit_void_confirm_title')}
        </h2>
        <p className="ops-sub" style={{ marginBottom: 12 }}>
          {t('remit_dialog_void_sub', { amount, reference, batch: remittance.batchId })}
        </p>

        {step === 'reason' ? (
          <>
            <p className="ops-note" style={{ marginBottom: 14 }}>{t('remit_void_explain')}</p>
            <div className="ops-field" style={{ marginBottom: 16 }}>
              <label className="ops-label" htmlFor="remit-reason">{t('remit_field_void_reason')}</label>
              <textarea
                id="remit-reason"
                className={`ops-input${reasonError ? ' error' : ''}`}
                placeholder={t('remit_field_void_reason_ph')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={reasonError ? 'remit-reason-error' : undefined}
              />
              {reasonError && <span id="remit-reason-error" role="alert" className="ops-error">{reasonError}</span>}
            </div>
            <div className="ops-actions" style={{ justifyContent: 'flex-end', width: '100%', gap: 10 }}>
              <button type="button" className="ops-btn ghost" onClick={onClose}>{t('remit_cancel')}</button>
              <button type="submit" className="ops-btn on">{t('remit_void_continue')}</button>
            </div>
          </>
        ) : (
          <>
            <p className="ops-note" style={{ marginBottom: 10 }}>{t('remit_void_confirm_body', { amount })}</p>
            <p className="ops-note" style={{ marginBottom: 16 }}>{t('remit_receipt_void_reason', { reason: reason.trim() })}</p>
            {serverError && <div role="alert" className="ops-toast error">{serverError}</div>}
            {/* Destructive action on the left, on purpose: "Continuar" sat on
                the right a moment ago, so a double click there lands on
                "Volver" instead of confirming the void unread. */}
            <div className="ops-actions" style={{ justifyContent: 'space-between', width: '100%', gap: 10 }}>
              <button type="submit" className="ops-btn danger" disabled={submitting}>
                {submitting ? t('remit_voiding') : t('remit_void_confirm')}
              </button>
              <button type="button" className="ops-btn ghost" onClick={() => { setStep('reason'); setServerError(null); }} disabled={submitting}>
                {t('remit_void_back')}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
