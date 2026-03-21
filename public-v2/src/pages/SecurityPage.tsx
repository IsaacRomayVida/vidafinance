import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';

export function SecurityPage() {
  const { t } = useTranslation();
  useRevealOnScroll();

  return (
    <>
      <Helmet>
        <title>VIDA — {t('pg_sec_badge')}</title>
        <meta name="description" content={t('pg_sec_sub')} />
      </Helmet>

      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" /><div className="hero-blob b2" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_sec_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_sec_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_sec_sub')}</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_enc_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_sec_enc_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`pg_sec_enc_${n}_t`)}</div>
                  <div className="trust-d">{t(`pg_sec_enc_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_infra_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_sec_infra_h')} /></h2>
          <p className="sp rv d2" style={{ maxWidth: 640, marginBottom: 40 }}>{t('pg_sec_infra_p')}</p>
          <div className="metrics rv d3">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className="metric">
                <div className="metric-v">{t(`pg_sec_infra_${n}_v`)}</div>
                <div className="metric-l">{t(`pg_sec_infra_${n}_l`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_practices_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_sec_practices_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`pg_sec_pr_${n}_t`)}</div>
                  <div className="trust-d">{t(`pg_sec_pr_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
