import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function InvestorsPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_inv_badge')}`);

  return (
    <>

      {/* Hero with CTA */}
      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_inv_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_inv_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 560, margin: '0 auto 44px', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_inv_sub')}</p>
            <div style={{ opacity: 0, animation: 'fu .9s ease .55s forwards' }}>
              <a href={`mailto:${t('pg_inv_cta_email')}`} className="hero-cta">{t('pg_inv_cta')}</a>
            </div>
          </div>
        </div>
      </section>

      {/* Market — 2-col lp-grid with sticky left */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_market_tag')}</div>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv d1" style={{ position: 'sticky', top: 120 }}>
              <h2 className="sh"><RichText html={t('pg_inv_market_h')} /></h2>
              <p className="sp" style={{ marginTop: 16 }}>{t('pg_inv_market_p')}</p>
            </div>
            <div className="rv d2">
              <div className="metrics" style={{ margin: 0 }}>
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="metric">
                    <div className="metric-v">{t(`pg_inv_market_${n}_v`)}</div>
                    <div className="metric-l">{t(`pg_inv_market_${n}_l`)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Model — steps */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_model_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_inv_model_h')} /></h2>
          <div className="steps" style={{ marginTop: 56 }}>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className={`step rv d${n + 1}`}>
                <div className="step-n">{n}</div>
                <div>
                  <div className="step-title">{t(`pg_inv_model_${n}_t`)}</div>
                  <div className="step-desc">{t(`pg_inv_model_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Governance — 2-col lp-grid */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_gov_tag')}</div>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv d1">
              <h2 className="sh"><RichText html={t('pg_inv_gov_h')} /></h2>
            </div>
            <div className="rv d2">
              <p className="sp" style={{ fontSize: 17, lineHeight: 1.8 }}>{t('pg_inv_gov_p')}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="closing">
        <div className="closing-glow" />
        <h2 className="rv"><RichText html={t('pg_inv_h1')} /></h2>
        <p className="closing-sub rv d1" style={{ marginBottom: 20 }}>{t('pg_inv_sub')}</p>
        <a href={`mailto:${t('pg_inv_cta_email')}`} className="closing-btn rv d2">{t('pg_inv_cta')}</a>
        <p className="rv d3" style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', marginTop: 16, position: 'relative', zIndex: 2 }}>{t('pg_inv_cta_email')}</p>
      </section>
    </>
  );
}
