import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MIN_CREDIT_LINE, selectableCreditLine } from '../../lib/creditLine';
import { sliderFillPercent } from '../../lib/loanSlider';
import { Board, BoardHead } from './Board';

function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// NOTE (audit): this duplicates the fee rate that ADR-002 put in ONE
// server-side place (functions/src/config/loanConfig.ts's LOAN_FEE_RATE), and
// since #389 that rate is admin-editable at runtime within [0, 0.35]. It agrees
// with the seed today. It cannot be sourced from the server here yet: this is
// an unauthenticated marketing page, `getLoanConfig` is employee-only, and
// firestore.rules denies `config/**` to every client. Publishing the rate to
// anonymous callers is the fix; see outputs/PUBLIC_V2_AUDIT.md F3.
const RATE = 0.30;

/**
 * Cost in plain sight. The visitor's salary sets the line (30% of salary,
 * capped at 5,000 — the same rule the backend enforces), the slider picks
 * the amount, and the total to repay appears on the same board, in the
 * same type as the copy, without a tap. The CAT is a regulated figure the
 * client must not compute or invent: until the product config publishes it
 * to anonymous callers the line renders it as pending, not omitted.
 */
export function ROICalculator() {
  const { t } = useTranslation();
  const [credit, setCredit] = useState(3000);
  const [salary, setSalary] = useState('15,000');

  // The salary this form asks for is what the credit line is derived from:
  // 30% of monthly salary, capped at $5,000 (functions/src/index.ts:74-75,
  // 3161). It used to be collected and then ignored — the slider ran to $5,000
  // for every visitor regardless of what they earned.
  const salaryNum = parseFloat(salary.replace(/,/g, ''));
  const maxCredit = selectableCreditLine(salaryNum);
  const eligible = maxCredit >= MIN_CREDIT_LINE;
  const effectiveCredit = eligible ? Math.min(credit, maxCredit) : MIN_CREDIT_LINE;

  const total = effectiveCredit * (1 + RATE);
  const whole = Math.floor(total);
  const fillPct = Math.min(100, Math.max(0, sliderFillPercent(effectiveCredit, maxCredit)));

  const handleSalaryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    setSalary(raw ? fmt(parseInt(raw)) : '');
  }, []);

  return (
    <Board tone="leaf" className="photo photo-pharmacy" id="cost">
      <div className="mk-cols">
        <div className="sticky">
          <BoardHead kicker={t('calc_tag')} title={t('calc_h2')} lead={t('calc_p')} />
        </div>

        <div>
          <div className="mk-field">
            <label htmlFor="calc-salary">{t('calc_salary')}</label>
            <div className="mk-money">
              <span className="pre" aria-hidden="true">$</span>
              <input
                id="calc-salary"
                className="mk-input"
                type="text"
                inputMode="numeric"
                aria-label={t('calc_salary')}
                value={salary}
                onChange={handleSalaryChange}
                placeholder={t('calc_salary_placeholder')}
              />
              <span className="suf" aria-hidden="true">MXN</span>
            </div>
          </div>

          <div className="mk-field">
            <label htmlFor="calc-credit">{t('calc_credit')}</label>
            <div className="mk-slider">
              <div className="track" aria-hidden="true"><div className="fill" style={{ width: `${fillPct}%` }} /></div>
              <input
                id="calc-credit"
                type="range"
                aria-label={t('calc_credit')}
                min={MIN_CREDIT_LINE}
                max={eligible ? maxCredit : MIN_CREDIT_LINE}
                step="100"
                disabled={!eligible}
                value={effectiveCredit}
                onChange={(e) => setCredit(parseInt(e.target.value))}
              />
            </div>
            <div className="mk-slider-labels">
              <span>{fmt(MIN_CREDIT_LINE)} MXN</span>
              <span>{fmt(eligible ? maxCredit : MIN_CREDIT_LINE)} MXN</span>
            </div>
          </div>

          <div className="mk-gap-sm" />
          <p className="mk-quiet" style={{ fontSize: 15 }}>{t('calc_result_credit')}</p>
          <div className="mk-num money" aria-live="polite">{eligible ? fmt(effectiveCredit) : '—'}<small>MXN</small></div>

          <p className="mk-disclose">
            {eligible ? (
              <>
                {t('calc_result_label')} <b>{fmt(whole)}</b> MXN · {t('calc_rate')} · {t('calc_term')} 30 {t('calc_days')} · {t('calc_disclose_charge')} · <b>{t('calc_cat_label')}</b> · {t('calc_cat_pending')}
              </>
            ) : (
              t('calc_note_below_min')
            )}
          </p>
          <p className="mk-disclose">{t('calc_note')} {t('calc_early')}</p>

          <div className="mk-actions">
            <Link to="/onboarding" className="mk-btn">{t('calc_cta')}</Link>
          </div>
        </div>
      </div>
    </Board>
  );
}
