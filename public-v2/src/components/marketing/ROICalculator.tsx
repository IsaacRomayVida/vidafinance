import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MIN_CREDIT_LINE, selectableCreditLine } from '../../lib/creditLine';
import { sliderFillPercent } from '../../lib/loanSlider';

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
  const cents = ((total - whole) * 100).toFixed(0).padStart(2, '0');
  const fillPct = Math.min(100, Math.max(0, sliderFillPercent(effectiveCredit, maxCredit)));

  const handleSalaryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    setSalary(raw ? fmt(parseInt(raw)) : '');
  }, []);

  return (
    <section className="calc">
      <div className="calc-glow" />
      <div className="wrap">
        <div className="calc-grid">
          <div className="calc-text">
            {/* Calculator person photo */}
            <div className="calc-person-img" style={{
              marginTop: 36, position: 'relative', display: 'inline-block',
            }}>
              {/* Decorative teal circle */}
              <div style={{
                position: 'absolute', bottom: 0, right: -20,
                width: 200, height: 200, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(168,213,208,0.1) 0%, transparent 65%)',
                filter: 'blur(24px)', pointerEvents: 'none',
              }} />
              {/* Decorative gold accent dot */}
              <div style={{
                position: 'absolute', top: 20, left: -10,
                width: 80, height: 80, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(162,134,87,0.06) 0%, transparent 65%)',
                filter: 'blur(12px)', pointerEvents: 'none',
              }} />
              <picture style={{ display: 'block' }}>
                <source srcSet="/images/calculator-person.webp" type="image/webp" />
                <img loading="lazy" src="/images/calculator-person.jpg" alt="Empleada calculando" style={{
                  width: 380, position: 'relative',
                  filter: 'drop-shadow(0 20px 44px rgba(25,68,69,0.12))',
                }} />
              </picture>
            </div>
            <div className="tag rv">{t('calc_tag')}</div>
            <h2 className="sh rv d1">{t('calc_h2')}</h2>
            <p className="sp rv d2">{t('calc_p')}</p>
          </div>
          <div className="calc-form rv d3">
            <div className="cf">
              <div className="cf-label">{t('calc_salary')}</div>
              <div className="sal-wrap">
                <span className="sal-pre">$</span>
                <input
                  className="sal-in"
                  type="text"
                  inputMode="numeric"
                  aria-label={t('calc_salary')}
                  value={salary}
                  onChange={handleSalaryChange}
                  placeholder={t('calc_salary_placeholder')}
                />
                <span className="sal-suf">MXN</span>
              </div>
            </div>
            <div className="cf">
              <div className="cf-row">
                <span className="cf-label">{t('calc_credit')}</span>
                <span className="cf-val">${fmt(effectiveCredit)}</span>
              </div>
              <div className="slider-wrap">
                <div className="sw">
                  <div className="sw-fill" style={{ width: `${fillPct}%` }} />
                </div>
                <input
                  type="range"
                  aria-label={t('calc_credit')}
                  min={MIN_CREDIT_LINE}
                  max={eligible ? maxCredit : MIN_CREDIT_LINE}
                  step="100"
                  disabled={!eligible}
                  value={effectiveCredit}
                  onChange={(e) => setCredit(parseInt(e.target.value))}
                />
                <div className="sw-labels">
                  <span>${fmt(MIN_CREDIT_LINE)}</span>
                  <span>${fmt(eligible ? maxCredit : MIN_CREDIT_LINE)}</span>
                </div>
              </div>
            </div>
            <div className="cf">
              <div className="cf-row">
                <span className="cf-label">{t('calc_term')}</span>
                <span className="cf-val">30 {t('calc_days')} &middot; {t('calc_rate')}</span>
              </div>
            </div>
            <div className="calc-line" />
            <div className="calc-result">
              <div className="calc-result-label">{t('calc_result_label')}</div>
              {eligible ? (
                <div className="calc-result-num">
                  <span className="cr">$</span>{fmt(whole)}<span className="dc">.{cents}</span>
                </div>
              ) : (
                <div className="calc-result-num">
                  <span className="cr">$</span>—
                </div>
              )}
            </div>
            <div className="calc-note">
              {eligible ? t('calc_note') : t('calc_note_below_min')}
            </div>
            <Link to="/onboarding" className="calc-cta">{t('calc_cta')}</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
