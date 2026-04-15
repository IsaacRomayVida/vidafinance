import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StepAmount } from './StepAmount';

/* ── constants ── */
export const MIN_AMOUNT = 500;
export const MAX_AMOUNT = 5000;
export const STEP_INCREMENT = 100;
export const MONTHLY_FEE = 0.30;
export const TERM_DAYS = 30;

export const LOAN_PURPOSES = [
  'emergency',
  'medical',
  'education',
  'home_repair',
  'transportation',
  'debt_consolidation',
  'other',
] as const;

export type LoanPurpose = (typeof LOAN_PURPOSES)[number];

export function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/* ── props ── */
export interface LoanWizardProps {
  /** Available credit from the employee's account */
  availableCredit?: number;
  /** Monthly salary for cap calculation */
  salary?: number;
  /** Called when user advances past step 1 */
  onNext?: (data: { amount: number; purpose: LoanPurpose }) => void;
}

/* ── component ── */
export function LoanWizard({ availableCredit, salary, onNext }: LoanWizardProps) {
  const { t } = useTranslation();

  /* ── derived max ── */
  const effectiveMax = useMemo(() => {
    const caps = [MAX_AMOUNT];
    if (availableCredit != null && availableCredit > 0) caps.push(availableCredit);
    if (salary != null && salary > 0) caps.push(Math.floor(salary * 0.3));
    const raw = Math.min(...caps);
    // Round down to nearest STEP_INCREMENT, but at least MIN_AMOUNT
    const rounded = Math.max(
      MIN_AMOUNT,
      Math.floor(raw / STEP_INCREMENT) * STEP_INCREMENT,
    );
    return rounded;
  }, [availableCredit, salary]);

  /* ── state ── */
  const [amount, setAmount] = useState(() => Math.min(1000, effectiveMax));
  const [purpose, setPurpose] = useState<LoanPurpose | ''>('');

  /* ── calculations ── */
  const fee = Math.round(amount * MONTHLY_FEE);
  const total = amount + fee;
  const cat =
    amount > 0
      ? ((Math.pow(1 + fee / amount, 365 / TERM_DAYS) - 1) * 100).toFixed(0)
      : '0';

  const handleNext = () => {
    if (!purpose) return;
    onNext?.({ amount, purpose });
  };

  return (
    <div>
      {/* Step indicator — only step 1 for now */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 32 }}>
        {[1, 2, 3, 4].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 10,
              background: s <= 1 ? 'var(--brand)' : 'rgba(25,68,69,0.08)',
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>

      {/* Card */}
      <div
        style={{
          background: '#fff',
          borderRadius: 20,
          padding: '32px 28px',
          boxShadow: '0 2px 8px rgba(25,68,69,0.02)',
          border: '1px solid rgba(25,68,69,0.04)',
        }}
      >
        <StepAmount
          amount={amount}
          onAmountChange={setAmount}
          purpose={purpose}
          onPurposeChange={setPurpose}
          min={MIN_AMOUNT}
          max={effectiveMax}
          step={STEP_INCREMENT}
          fee={fee}
          total={total}
          cat={cat}
          onNext={handleNext}
        />
      </div>

      {/* Step label under card */}
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <span style={{ fontSize: 12, color: 'var(--t3)' }}>
          {t('wiz_step_indicator', { current: 1, total: 4 })}
        </span>
      </div>
    </div>
  );
}
