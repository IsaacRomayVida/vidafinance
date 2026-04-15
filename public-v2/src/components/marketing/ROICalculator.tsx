import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const RATE = 0.30;

export function ROICalculator() {
  const { t } = useTranslation();
  const [credit, setCredit] = useState(3000);
  const [salary, setSalary] = useState('15,000');

  const total = credit * (1 + RATE);
  const whole = Math.floor(total);
  const cents = ((total - whole) * 100).toFixed(0).padStart(2, '0');
  const fillPct = ((credit - 500) / 4500) * 100;

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
              <picture>
                <source srcSet="/images/calculator-person.webp" type="image/webp" />
                <img loading="lazy" src="/images/calculator-person.png" alt="Empleada calculando"
                  width={500} height={626}
                  style={{
                    width: 380, height: 'auto', position: 'relative',
                    filter: 'drop-shadow(0 20px 44px rgba(25,68,69,0.12))',
                  }}
                />
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
                <span className="cf-val">${fmt(credit)}</span>
              </div>
              <div className="slider-wrap">
                <div className="sw">
                  <div className="sw-fill" style={{ width: `${fillPct}%` }} />
                </div>
                <input
                  type="range"
                  min="500"
                  max="5000"
                  step="100"
                  value={credit}
                  onChange={(e) => setCredit(parseInt(e.target.value))}
                />
                <div className="sw-labels"><span>$500</span><span>$5,000</span></div>
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
              <div className="calc-result-num">
                <span className="cr">$</span>{fmt(whole)}<span className="dc">.{cents}</span>
              </div>
            </div>
            <div className="calc-note">{t('calc_note')}</div>
            <Link to="/onboarding" className="calc-cta">{t('calc_cta')}</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
