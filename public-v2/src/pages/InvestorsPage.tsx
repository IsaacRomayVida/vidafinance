import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';

export function InvestorsPage() {
  const { t } = useTranslation();
  useRevealOnScroll();

  return (
    <>
      <Helmet>
        <title>{t('pg_inv_h1')} | Vida</title>
        <meta name="description" content={t('pg_inv_sub')} />
      </Helmet>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_inv_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_inv_h1')} /></h1>
          <p className="sub rv d2">{t('pg_inv_sub')}</p>
        </div>
      </section>

      {/* Market */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_market_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_inv_market_h')} /></h2>
          <p className="sp rv d2">{t('pg_inv_market_p')}</p>
          <div className="metrics rv d2">
            {[1, 2, 3, 4].map((i) => (
              <div className="metric" key={i}>
                <div className="metric-v">{t(`pg_inv_market_${i}_v`)}</div>
                <div className="metric-l">{t(`pg_inv_market_${i}_l`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Model */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_model_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_inv_model_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((i) => (
              <div className="trust-item" key={i}>
                <div>
                  <div className="trust-t">{t(`pg_inv_model_${i}_t`)}</div>
                  <div className="trust-d">{t(`pg_inv_model_${i}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Governance */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_inv_gov_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_inv_gov_h')} /></h2>
          <p className="sp rv d2">{t('pg_inv_gov_p')}</p>
        </div>
      </section>

      {/* CTA */}
      <section className="section">
        <div className="wrap text-center">
          <h2 className="sh rv"><RichText html={t('pg_inv_cta')} /></h2>
          <a href={`mailto:${t('pg_inv_cta_email')}`} className="btn rv d1">
            {t('pg_inv_cta_email')}
          </a>
        </div>
      </section>
    </>
  );
}
