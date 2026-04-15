import { useTranslation } from 'react-i18next';
import { LOAN_PURPOSES, fmt } from './LoanWizard';
import type { LoanPurpose } from './LoanWizard';

/* ── props ── */
export interface StepAmountProps {
  amount: number;
  onAmountChange: (v: number) => void;
  purpose: LoanPurpose | '';
  onPurposeChange: (v: LoanPurpose) => void;
  min: number;
  max: number;
  step: number;
  fee: number;
  total: number;
  cat: string;
  onNext: () => void;
}

/* ── quick-pick amounts ── */
const QUICK_AMOUNTS = [500, 1000, 2000, 3000, 5000];

export function StepAmount({
  amount,
  onAmountChange,
  purpose,
  onPurposeChange,
  min,
  max,
  step,
  fee,
  total,
  cat,
  onNext,
}: StepAmountProps) {
  const { t } = useTranslation();

  const sliderPct = max > min ? ((amount - min) / (max - min)) * 100 : 0;
  const validQuickAmounts = QUICK_AMOUNTS.filter((v) => v >= min && v <= max);

  return (
    <div>
      {/* Header */}
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 2.2,
          color: 'var(--gold)',
          marginBottom: 8,
        }}
      >
        {t('wiz_step_1_label')}
      </div>
      <h3
        style={{
          fontFamily: 'var(--df)',
          fontSize: 20,
          color: 'var(--t1)',
          margin: '0 0 24px',
        }}
      >
        {t('wiz_step_1_title')}
      </h3>

      {/* ─── Amount display ─── */}
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div
          style={{
            fontFamily: 'var(--df)',
            fontSize: 48,
            color: 'var(--t1)',
            lineHeight: 1,
            marginBottom: 4,
          }}
        >
          ${fmt(amount)}
        </div>
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>MXN</div>
      </div>

      {/* ─── Slider ─── */}
      <div className="slider-wrap">
        <div className="sw">
          <div className="sw-fill" style={{ width: `${sliderPct}%` }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={amount}
          onChange={(e) => onAmountChange(parseInt(e.target.value))}
        />
        <div className="sw-labels">
          <span>${fmt(min)}</span>
          <span>${fmt(max)}</span>
        </div>
      </div>

      {/* ─── Quick amount buttons ─── */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {validQuickAmounts.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onAmountChange(v)}
            style={{
              flex: '1 1 auto',
              padding: '10px 0',
              borderRadius: 10,
              border:
                amount === v
                  ? '1.5px solid var(--brand)'
                  : '1.5px solid rgba(25,68,69,0.08)',
              background: amount === v ? 'var(--brand)' : 'transparent',
              color: amount === v ? '#fff' : 'var(--t2)',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--db)',
              cursor: 'pointer',
              transition: 'all 0.25s ease',
              minWidth: 60,
            }}
          >
            ${fmt(v)}
          </button>
        ))}
      </div>

      {/* ─── Live fee breakdown ─── */}
      <div
        style={{
          borderTop: '1px solid rgba(25,68,69,0.06)',
          borderBottom: '1px solid rgba(25,68,69,0.06)',
          padding: '16px 0',
          margin: '24px 0 20px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 0',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>
            {t('modal_loan_amount')}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
            ${fmt(amount)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 0',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>
            {t('modal_fee')} (30%)
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
            ${fmt(fee)}
          </span>
        </div>
        <div
          style={{
            height: 1,
            background: 'rgba(25,68,69,0.06)',
            margin: '4px 0',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 0',
          }}
        >
          <span
            style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}
          >
            {t('modal_total')}
          </span>
          <span
            style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}
          >
            ${fmt(total)}
          </span>
        </div>
      </div>

      {/* ─── CAT disclosure ─── */}
      <div
        style={{
          background: 'var(--bg2)',
          borderRadius: 12,
          padding: '14px 16px',
          border: '1px solid rgba(25,68,69,0.04)',
          marginBottom: 28,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>
            {t('modal_cat_label')}
          </span>
          <span className="cat-highlight">
            {cat}
            {t('modal_cat_annual')}
          </span>
        </div>
        <p
          style={{
            fontSize: 11,
            color: 'var(--t3)',
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {t('modal_cat_note')}{' '}
          <a
            href="https://www.condusef.gob.mx"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--brand)' }}
          >
            {t('modal_cat_condusef')}
          </a>
        </p>
      </div>

      {/* ─── Purpose selector ─── */}
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 2.2,
          color: 'var(--gold)',
          marginBottom: 8,
        }}
      >
        {t('modal_purpose_label')}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginBottom: 28,
        }}
      >
        {LOAN_PURPOSES.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPurposeChange(p)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 16px',
              borderRadius: 12,
              border:
                purpose === p
                  ? '1.5px solid var(--brand)'
                  : '1.5px solid rgba(25,68,69,0.08)',
              background:
                purpose === p ? 'rgba(25,68,69,0.03)' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.25s ease',
              textAlign: 'left',
              fontFamily: 'var(--db)',
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                border:
                  purpose === p
                    ? '6px solid var(--brand)'
                    : '2px solid rgba(25,68,69,0.15)',
                flexShrink: 0,
                transition: 'border 0.2s ease',
              }}
            />
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: purpose === p ? 'var(--t1)' : 'var(--t2)',
              }}
            >
              {t(`modal_purpose_${p}`)}
            </span>
          </button>
        ))}
      </div>

      {/* ─── Continue button ─── */}
      <button
        onClick={onNext}
        disabled={!purpose}
        className="btn-primary"
      >
        {t('wiz_next')}
      </button>
    </div>
  );
}
