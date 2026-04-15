import { useTranslation } from 'react-i18next';

const TERM_DAYS = 30;
const BIWEEKLY_PERIODS = 2; // 2 biweekly periods in a 30-day loan

interface StepPreviewProps {
  amount: number;
  fee: number;
  total: number;
  dueDate: Date;
  cat: string;
  onBack: () => void;
  onNext: () => void;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d: Date, locale: string): string {
  return d.toLocaleDateString(locale === 'es' ? 'es-MX' : 'en-US', {
    day: 'numeric',
    month: 'short',
  });
}

export function StepPreview({
  amount,
  fee,
  total,
  dueDate,
  cat,
  onBack,
  onNext,
}: StepPreviewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const biweeklyDeduction = Math.round(total / BIWEEKLY_PERIODS);
  const today = new Date();
  // First deduction ~15 days from now, second at due date
  const firstDeductionDate = new Date(today.getTime() + 15 * 24 * 60 * 60 * 1000);
  const secondDeductionDate = dueDate;

  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 2.2,
    color: 'var(--gold)',
    marginBottom: 6,
  };

  const cardBg: React.CSSProperties = {
    background: 'var(--bg2)',
    borderRadius: 12,
    padding: '16px 14px',
    border: '1px solid rgba(25,68,69,0.04)',
  };

  return (
    <div>
      {/* Step label */}
      <div style={{ ...labelStyle, marginBottom: 8 }}>
        {t('wiz_step_2_label')}
      </div>
      <h3 style={{ fontFamily: 'var(--df)', fontSize: 20, color: 'var(--t1)', margin: '0 0 24px' }}>
        {t('wiz_step_2_title')}
      </h3>

      {/* Term & fee cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        <div style={cardBg}>
          <div style={labelStyle}>{t('modal_term')}</div>
          <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
            {TERM_DAYS} {t('calc_days')}
          </div>
        </div>
        <div style={cardBg}>
          <div style={labelStyle}>{t('wiz_monthly_fee')}</div>
          <div style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>
            30%
          </div>
        </div>
      </div>

      {/* Full cost breakdown */}
      <div style={{
        borderTop: '1px solid rgba(25,68,69,0.06)',
        borderBottom: '1px solid rgba(25,68,69,0.06)',
        padding: '16px 0',
        marginBottom: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(amount)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_fee')}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(fee)}</span>
        </div>
        <div style={{ height: 1, background: 'rgba(25,68,69,0.06)', margin: '4px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <span style={{ fontFamily: 'var(--df)', fontSize: 15, color: 'var(--t1)' }}>{t('modal_total')}</span>
          <span style={{ fontFamily: 'var(--df)', fontSize: 18, color: 'var(--t1)' }}>${fmt(total)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('wiz_biweekly_deduction')}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>${fmt(biweeklyDeduction)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_due_date')}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{dueDate.toLocaleDateString()}</span>
        </div>
      </div>

      {/* Payroll deduction timeline */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ ...labelStyle, marginBottom: 14 }}>
          {t('wiz_payroll_timeline')}
        </div>
        <div style={{ position: 'relative', padding: '0 0 0 20px' }}>
          {/* Vertical line */}
          <div style={{
            position: 'absolute',
            left: 7,
            top: 6,
            bottom: 6,
            width: 2,
            background: 'rgba(25,68,69,0.08)',
            borderRadius: 1,
          }} />

          {/* Today - Disbursement */}
          <TimelineNode
            color="var(--brand)"
            filled
            label={t('wiz_timeline_disbursement')}
            date={fmtDate(today, locale)}
            value={`+$${fmt(amount)}`}
            valueColor="var(--brand-light)"
          />

          {/* First biweekly deduction */}
          <TimelineNode
            color="var(--gold)"
            filled={false}
            label={t('wiz_timeline_deduction', { n: 1 })}
            date={fmtDate(firstDeductionDate, locale)}
            value={`-$${fmt(biweeklyDeduction)}`}
            valueColor="var(--t2)"
          />

          {/* Second biweekly deduction (due date) */}
          <TimelineNode
            color="var(--gold)"
            filled={false}
            label={t('wiz_timeline_deduction', { n: 2 })}
            date={fmtDate(secondDeductionDate, locale)}
            value={`-$${fmt(total - biweeklyDeduction)}`}
            valueColor="var(--t2)"
            sublabel={t('wiz_timeline_paid_off')}
          />
        </div>
      </div>

      {/* CNBV-compliant CAT disclosure */}
      <div style={{
        background: 'var(--bg2)',
        borderRadius: 12,
        padding: '14px 16px',
        border: '1px solid rgba(25,68,69,0.04)',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 13, color: 'var(--t3)' }}>{t('modal_cat_label')}</span>
          <span className="cat-highlight">{cat}{t('modal_cat_annual')}</span>
        </div>
        <p style={{ fontSize: 11, color: 'var(--t3)', margin: '0 0 6px', lineHeight: 1.5 }}>
          {t('wiz_cat_cnbv_disclosure')}
        </p>
        <p style={{ fontSize: 11, color: 'var(--t3)', margin: 0, lineHeight: 1.5 }}>
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

      {/* Navigation buttons */}
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={onBack}
          type="button"
          style={{
            flex: '0 0 auto',
            padding: '14px 20px',
            borderRadius: 12,
            border: '1.5px solid rgba(25,68,69,0.08)',
            background: 'transparent',
            color: 'var(--t2)',
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'var(--db)',
            cursor: 'pointer',
          }}
        >
          {t('wiz_back')}
        </button>
        <button
          onClick={onNext}
          className="btn-primary"
          style={{ flex: 1 }}
        >
          {t('wiz_next')}
        </button>
      </div>
    </div>
  );
}

function TimelineNode({
  color,
  filled,
  label,
  date,
  value,
  valueColor,
  sublabel,
}: {
  color: string;
  filled: boolean;
  label: string;
  date: string;
  value: string;
  valueColor: string;
  sublabel?: string;
}) {
  return (
    <div style={{ position: 'relative', paddingBottom: 20, paddingLeft: 16 }}>
      {/* Dot */}
      <div style={{
        position: 'absolute',
        left: -14,
        top: 5,
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        background: filled ? color : '#fff',
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', marginBottom: 2 }}>
            {label}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>{date}</div>
          {sublabel && (
            <div style={{
              fontSize: 11,
              color: 'var(--brand-light)',
              fontWeight: 600,
              marginTop: 3,
            }}>
              {sublabel}
            </div>
          )}
        </div>
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          color: valueColor,
          fontFamily: 'var(--df)',
        }}>
          {value}
        </div>
      </div>
    </div>
  );
}
