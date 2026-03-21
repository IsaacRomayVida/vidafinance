import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function AboutPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_about_badge')}`);

  return (
    <>

      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_about_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_about_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_about_sub')}</p>
          </div>
        </div>
      </section>

      {/* Mission — 2-col grid */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_mission_tag')}</div>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv d1">
              <h2 className="sh"><RichText html={t('pg_about_mission_h')} /></h2>
            </div>
            <div className="rv d2">
              <p className="sp" style={{ fontSize: 17, lineHeight: 1.8 }}>{t('pg_about_mission_p')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Structure — steps with country codes */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_struct_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_about_struct_h')} /></h2>
          <div className="steps" style={{ marginTop: 56 }}>
            <div className="step rv d2">
              <div className="step-n">CH</div>
              <div>
                <div className="step-title">{t('pg_about_struct_1_t')}</div>
                <div className="step-desc">{t('pg_about_struct_1_d')}</div>
              </div>
            </div>
            <div className="step rv d3">
              <div className="step-n">MX</div>
              <div>
                <div className="step-title">{t('pg_about_struct_2_t')}</div>
                <div className="step-desc">{t('pg_about_struct_2_d')}</div>
              </div>
            </div>
            <div className="step rv d4">
              <div className="step-n">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="20" height="20">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              </div>
              <div>
                <div className="step-title">{t('pg_about_struct_3_t')}</div>
                <div className="step-desc">{t('pg_about_struct_3_d')}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Values — 2x2 grid with borders */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_values_tag')}</div>
          <h2 className="sh rv d1" style={{ maxWidth: 480 }}><RichText html={t('pg_about_values_h')} /></h2>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, marginTop: 56, borderTop: '1px solid rgba(25,68,69,0.04)' }}>
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`rv d${n + 1}`}
                style={{
                  padding: n % 2 === 1 ? '40px 40px 40px 0' : '40px 0 40px 40px',
                  borderBottom: n <= 2 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                  borderRight: n % 2 === 1 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{t(`pg_about_val_${n}_t`)}</div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.6 }}>{t(`pg_about_val_${n}_d`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="closing">
        <div className="closing-glow" />
        <h2 className="rv"><RichText html={t('close_h2')} /></h2>
        <p className="closing-sub rv d1">{t('close_sub')}</p>
        <Link to="/onboarding" className="closing-btn rv d2">{t('close_cta')}</Link>
      </section>
    </>
  );
}
