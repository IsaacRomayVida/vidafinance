import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';

export function TermsPage() {
  const { t } = useTranslation();
  useRevealOnScroll();

  return (
    <>
      <Helmet>
        <title>{t('pg_terms_h1')} | Vida</title>
        <meta name="description" content={t('pg_terms_intro')} />
      </Helmet>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_terms_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_terms_h1')} /></h1>
          <p className="sub rv d2">{t('pg_terms_updated')}</p>
        </div>
      </section>

      {/* Content */}
      <section className="section">
        <div className="wrap legal-page">
          <p className="sp rv">{t('pg_terms_intro')}</p>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="rv d1">
              <h2 className="sh">{t(`pg_terms_${i}_t`)}</h2>
              <p className="sp">{t(`pg_terms_${i}_p`)}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
