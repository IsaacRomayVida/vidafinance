import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { friendlyError } from '../../lib/errors';
import { formatCents, parsePesosToCents } from '../../lib/money';
import {
  BANK_REFERENCE_MAX,
  bankReferenceProblem,
  formatIsoDate,
  readRemittanceRefusal,
  receivedOnProblem,
  remittanceRefusalText,
  todayInMexicoCity,
  type BankReferenceProblem,
  type ReceivedOnProblem,
  type RecordRemittanceInput,
  type RecordRemittanceResult,
  type Remittance,
} from '../../lib/remittance';

interface Props {
  remittance: Remittance;
  employerLabel: string;
  onClose: () => void;
  onRecorded: (result: RecordRemittanceResult, amountCents: number) => void;
}

type AmountProblem = 'invalid' | 'positive';

interface FieldErrors {
  amount: AmountProblem | null;
  receivedOn: ReceivedOnProblem | null;
  bankReference: BankReferenceProblem | null;
}

const NO_ERRORS: FieldErrors = { amount: null, receivedOn: null, bankReference: null };

/**
 * Books one bank transfer against one payroll batch. The checks here mirror
 * recordPayrollRemittance so ops hears about a typo before the round trip;
 * the server re-checks all of them and is the one that knows about duplicates.
 */
export function RemittanceRecordDialog({ remittance, employerLabel, onClose, onRecorded }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'en' ? 'en-US' : 'es-MX';
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; offerShared: boolean } | null>(null);
  const sheetRef = useFocusTrap<HTMLFormElement>(onClose);

  const today = todayInMexicoCity();
  const typedCents = parsePesosToCents(amount);
  const overpays = typedCents !== null && typedCents > remittance.aging.outstandingCents;

  // The server answers a refusal with `details.reason`; the words come from
  // this side, in the UI's language. Its English `message` is never shown.
  const describe = (err: unknown): { message: string; offerShared: boolean } => {
    const refusal = readRemittanceRefusal(err);
    return {
      message: remittanceRefusalText(refusal, t, locale) ?? friendlyError(err),
      // Only this one refusal has a way through: ops saying the transfer
      // really did pay more than one batch.
      offerShared: refusal.reason === 'bank-reference-in-other-batch',
    };
  };

  const submit = async (sharedTransfer: boolean) => {
    if (submitting) return;
    const cents = parsePesosToCents(amount);
    const next: FieldErrors = {
      amount: cents === null ? 'invalid' : cents <= 0 ? 'positive' : null,
      // Read the clock again: a dialog left open over midnight must not keep
      // yesterday's "today".
      receivedOn: receivedOnProblem(receivedOn, todayInMexicoCity(), remittance.payPeriodStart),
      bankReference: bankReferenceProblem(bankReference),
    };
    setErrors(next);
    if (cents === null || next.amount || next.receivedOn || next.bankReference) return;

    setSubmitting(true);
    setServerError(null);
    try {
      const fn = httpsCallable<RecordRemittanceInput, RecordRemittanceResult>(getFunctions(), 'recordPayrollRemittance');
      const input: RecordRemittanceInput = {
        batchId: remittance.batchId,
        amountCents: cents,
        receivedOn,
        bankReference: bankReference.trim(),
      };
      if (sharedTransfer) input.sharedTransfer = true;
      const result = await fn(input);
      onRecorded(result.data, cents);
    } catch (err: unknown) {
      setServerError(describe(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(false);
  };

  const amountError =
    errors.amount === 'invalid' ? t('remit_val_amount_invalid') : errors.amount === 'positive' ? t('remit_val_amount_positive') : null;
  const dateError =
    errors.receivedOn === 'required'
      ? t('remit_val_date_required')
      : errors.receivedOn === 'invalid'
        ? t('remit_val_date_invalid')
        : errors.receivedOn === 'future'
          ? t('remit_val_date_future', { today })
          : errors.receivedOn === 'before_period'
            ? t('remit_val_date_before_period', { start: formatIsoDate(remittance.payPeriodStart, locale) })
            : null;
  const referenceError =
    errors.bankReference === 'required'
      ? t('remit_val_reference_required')
      : errors.bankReference === 'too_long'
        ? t('remit_val_reference_too_long', { max: BANK_REFERENCE_MAX })
        : null;

  return (
    <div className="ops-overlay" role="dialog" aria-modal="true" aria-labelledby="remit-record-title">
      <form ref={sheetRef} className="ops-card ops-sheet" onSubmit={onSubmit} noValidate>
        <h2 id="remit-record-title" className="ops-h3">{t('remit_dialog_record_title')}</h2>
        <p className="ops-sub">
          {t('remit_dialog_record_sub', {
            employer: employerLabel,
            batch: remittance.batchId,
            outstanding: formatCents(remittance.aging.outstandingCents),
          })}
        </p>

        <div className="ops-field">
          <label className="ops-label" htmlFor="remit-amount">{t('remit_field_amount')}</label>
          <input
            id="remit-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className={`ops-input${amountError ? ' error' : ''}`}
            placeholder={t('remit_field_amount_ph')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? 'remit-amount-error' : undefined}
          />
          {amountError && <span id="remit-amount-error" role="alert" className="ops-error">{amountError}</span>}
          {!amountError && overpays && <span className="ops-note">{t('remit_overpay_note')}</span>}
        </div>

        <div className="ops-field">
          <label className="ops-label" htmlFor="remit-date">{t('remit_field_received_on')}</label>
          <input
            id="remit-date"
            type="date"
            className={`ops-input${dateError ? ' error' : ''}`}
            max={today}
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={dateError ? 'remit-date-error' : undefined}
          />
          {dateError && <span id="remit-date-error" role="alert" className="ops-error">{dateError}</span>}
        </div>

        <div className="ops-field">
          <label className="ops-label" htmlFor="remit-reference">{t('remit_field_reference')}</label>
          <input
            id="remit-reference"
            type="text"
            autoComplete="off"
            className={`ops-input mono${referenceError ? ' error' : ''}`}
            placeholder={t('remit_field_reference_ph')}
            value={bankReference}
            onChange={(e) => {
              setBankReference(e.target.value);
              // The shared-transfer offer was about the reference that was
              // rejected; a different reference has not been checked yet.
              setServerError(null);
            }}
            aria-invalid={referenceError ? true : undefined}
            aria-describedby={referenceError ? 'remit-reference-error' : undefined}
          />
          {referenceError && <span id="remit-reference-error" role="alert" className="ops-error">{referenceError}</span>}
        </div>

        {serverError && (
          <div role="alert" className="ops-toast error ops-sheet-alert">
            <span>{serverError.message}</span>
            {serverError.offerShared && (
              <>
                <span className="ops-note">{t('remit_shared_question')}</span>
                <button type="button" className="ops-btn sm ghost" disabled={submitting} onClick={() => void submit(true)}>
                  {t('remit_shared_confirm')}
                </button>
              </>
            )}
          </div>
        )}

        <div className="ops-actions end">
          <button type="button" className="ops-btn ghost" onClick={onClose} disabled={submitting}>{t('remit_cancel')}</button>
          <button type="submit" className="ops-btn on" disabled={submitting}>
            {submitting ? t('remit_submitting') : t('remit_submit_record')}
          </button>
        </div>
      </form>
    </div>
  );
}
