import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function EmployeePage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('lp_m_badge')}`);

  const [salary, setSalary] = useState(15000);
  const credit = Math.min(Math.round(salary * 0.30 / 100) * 100, 5000);
  const fee = Math.round(credit * 0.30);
  const total = credit + fee;

  const handleSalaryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    setSalary(raw ? parseInt(raw) : 0);
  }, []);

  const arrow = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );

  return (
    <>
      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" /><div className="hero-blob b2" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('lp_m_badge')}</span>
            </div>
            <h1 style={{ fontFamily: 'var(--df)', fontSize: 'clamp(40px, 8vw, 72px)', color: 'var(--t1)', lineHeight: '.96', letterSpacing: '-.045em', marginBottom: 24, opacity: 0, animation: 'fu .9s ease .3s forwards' }}>
              <RichText html={t('lp_m_h1')} />
            </h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto 44px', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('lp_m_sub')}</p>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', opacity: 0, animation: 'fu .9s ease .55s forwards' }}>
              <Link to="/onboarding" className="hero-cta">{t('lp_m_cta')} {arrow}</Link>
            </div>
            <p className="rv d1" style={{ marginTop: 16, fontSize: 14, color: 'var(--t3)' }}>
              {t('lp_m_no_code')}{' '}
              <Link to="/employers" style={{ color: 'var(--brand-light)' }}>{t('lp_m_no_code_link')}</Link>
            </p>
          </div>
        </div>
      </section>

      {/* What you get */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('lp_m_what_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('lp_m_what_h')} /></h2>
          <div className="metrics rv d2" style={{ margin: '40px 0 0' }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="metric">
                <div className="metric-v">{t(`lp_m_what_${n}_v`)}</div>
                <div className="metric-l">{t(`lp_m_what_${n}_l`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Credit simulator widget */}
      <section className="section tinted">
        <div className="wrap">
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv" style={{ position: 'sticky', top: 120 }}>
              <div className="tag">{t('lp_m_widget_tag')}</div>
              <h2 className="sh"><RichText html={t('lp_m_widget_h')} /></h2>
              <p className="sp">{t('lp_m_widget_sub')}</p>
            </div>
            <div className="calc-form rv d2">
              <div className="cf">
                <div className="cf-label">{t('lp_m_widget_salary')}</div>
                <div className="sal-wrap">
                  <span className="sal-pre">$</span>
                  <input className="sal-in" type="text" inputMode="numeric" value={fmt(salary)} onChange={handleSalaryChange} placeholder={t('lp_m_widget_salary_ph')} />
                  <span className="sal-suf">MXN</span>
                </div>
              </div>
              <div className="calc-line" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 32px' }}>
                <div><div className="cf-label">{t('lp_m_widget_available')}</div><div className="metric-v">${fmt(credit)}</div></div>
                <div><div className="cf-label">{t('lp_m_widget_rate')}</div><div className="metric-v">{t('lp_m_widget_rate_val')}</div></div>
                <div><div className="cf-label">{t('lp_m_widget_term')}</div><div className="metric-v">{t('lp_m_widget_term_val')}</div></div>
                <div><div className="cf-label">{t('lp_m_widget_repayment')}</div><div className="metric-v">${fmt(total)}</div></div>
                <div><div className="cf-label">{t('lp_m_widget_deduction')}</div><div className="metric-v">${fmt(fee)}/mo</div></div>
                <div><div className="cf-label">{t('lp_m_widget_disbursement')}</div><div className="metric-v">{t('lp_m_widget_disbursement_val')}</div></div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '20px 0' }}>
                <span className="badge-text" style={{ fontSize: 12, background: 'rgba(36,122,110,.08)', padding: '4px 10px', borderRadius: 20 }}>{t('lp_m_widget_preapproved')}</span>
                <span className="badge-text" style={{ fontSize: 12, background: 'rgba(36,122,110,.08)', padding: '4px 10px', borderRadius: 20 }}>{t('lp_m_widget_no_check')}</span>
                <span className="badge-text" style={{ fontSize: 12, background: 'rgba(36,122,110,.08)', padding: '4px 10px', borderRadius: 20 }}>{t('lp_m_widget_no_paperwork')}</span>
              </div>
              <Link to="/onboarding" className="calc-cta">{t('lp_m_widget_cta')}</Link>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('lp_m_how_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('lp_m_how_h')} /></h2>
          <div className="steps" style={{ maxWidth: 600 }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className={`step rv d${n}`}>
                <div className="step-n">{n}</div>
                <div>
                  <div className="step-title">{t(`lp_m_how_${n}_t`)}</div>
                  <div className="step-desc">{t(`lp_m_how_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Use cases */}
      <section className="section tinted">
        <div className="wrap">
          <div className="scenario-header">
            <div className="tag rv">{t('lp_m_use_tag')}</div>
            <h2 className="sh rv d1"><RichText html={t('lp_m_use_h')} /></h2>
          </div>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`lp_m_use_${n}_t`)}</div>
                  <div className="trust-d">{t(`lp_m_use_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Ask employer */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('lp_m_ask_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('lp_m_ask_h')} /></h2>
          <p className="sp rv d2">{t('lp_m_ask_sub')}</p>
          <div className="steps rv d3" style={{ maxWidth: 600 }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="step">
                <div className="step-n">{n}</div>
                <div>
                  <div className="step-title">{t(`lp_m_ask_${n}_t`)}</div>
                  <div className="step-desc">{t(`lp_m_ask_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing */}
      <section className="closing">
        <div className="closing-glow" />
        <h2 className="rv"><RichText html={t('lp_m_close_h')} /></h2>
        <p className="closing-sub rv d1">{t('lp_m_close_sub')}</p>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/onboarding" className="closing-btn rv d2">{t('lp_m_close_cta')}</Link>
          <Link to="/employers" className="closing-btn rv d3" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,.3)' }}>
            {t('lp_m_close_cta2')}
          </Link>
        </div>
      </section>
    </>
  );
}
