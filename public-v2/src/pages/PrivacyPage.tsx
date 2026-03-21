import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PrivacyPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_priv_badge')}`);

  return (
    <>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_priv_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_priv_h1')} /></h1>
          <p className="sub rv d2">{t('pg_priv_updated')}</p>
        </div>
      </section>

      {/* Content */}
      <section className="section">
        <div className="wrap legal-page">
          <p className="sp rv">{t('pg_priv_intro')}</p>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="rv d1">
              <h2 className="sh">{t(`pg_priv_${i}_t`)}</h2>
              <p className="sp">{t(`pg_priv_${i}_p`)}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
