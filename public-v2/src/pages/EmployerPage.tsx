import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const arrow = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

export function EmployerPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('lp_e_badge')}`);

  return (
    <>

      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" /><div className="hero-blob b2" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('lp_e_badge')}</span>
            </div>
            <h1 style={{ fontFamily: 'var(--df)', fontSize: 'clamp(40px, 8vw, 72px)', color: 'var(--t1)', lineHeight: '.96', letterSpacing: '-.045em', marginBottom: 24, opacity: 0, animation: 'fu .9s ease .3s forwards' }}>
              <RichText html={t('lp_e_h1')} />
            </h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto 44px', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('lp_e_sub')}</p>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', opacity: 0, animation: 'fu .9s ease .55s forwards' }}>
              <Link to="/onboarding" className="hero-cta">{t('lp_e_cta')} {arrow}</Link>
              <Link to="/login" className="hero-cta-2">{t('lp_e_login')}</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Why VIDA */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('lp_e_why_tag')}</div>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv d1" style={{ position: 'sticky', top: 120 }}>
              <h2 className="sh"><RichText html={t('lp_e_why_h')} /></h2>
              <p className="sp">{t('lp_e_why_p')}</p>
            </div>
            <div className="rv d2">
              {/* HR Director photo */}
              <div style={{ marginBottom: 32, borderRadius: 20, overflow: 'hidden', boxShadow: '0 16px 48px rgba(25,68,69,0.1)' }}>
                <img loading="lazy" src="/images/hr-director.png" alt="Director de RRHH" style={{ width: '100%', display: 'block' }} />
              </div>
              <div className="metrics" style={{ margin: 0 }}>
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="metric">
                    <div className="metric-v">{t(`lp_e_why_${n}_v`)}</div>
                    <div className="metric-l">{t(`lp_e_why_${n}_l`)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section tinted">
        <div className="wrap">
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv" style={{ position: 'sticky', top: 120 }}>
              <div className="tag">{t('lp_e_how_tag')}</div>
              <h2 className="sh"><RichText html={t('lp_e_how_h')} /></h2>
            </div>
            <div className="steps">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className={`step rv d${n}`}>
                  <div className="step-n">{n}</div>
                  <div>
                    <div className="step-title">{t(`lp_e_how_${n}_t`)}</div>
                    <div className="step-desc">{t(`lp_e_how_${n}_d`)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('lp_e_ben_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('lp_e_ben_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`lp_e_ben_${n}_t`)}</div>
                  <div className="trust-d">{t(`lp_e_ben_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Close */}
      <section className="closing">
        <div className="closing-glow" />
        <h2 className="rv"><RichText html={t('lp_e_close_h')} /></h2>
        <p className="closing-sub rv d1">{t('lp_e_close_sub')}</p>
        <Link to="/onboarding" className="closing-btn rv d2">{t('lp_e_cta')} {arrow}</Link>
      </section>
    </>
  );
}
