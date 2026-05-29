import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function AboutPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`Funpay — ${t('pg_about_badge')}`);

  return (
    <>

      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" /><div className="hero-blob b2" />
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

      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_mission_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_about_mission_h')} /></h2>
          <p className="sp rv d2" style={{ maxWidth: 640 }}>{t('pg_about_mission_p')}</p>
        </div>
      </section>

      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_struct_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_about_struct_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`pg_about_struct_${n}_t`)}</div>
                  <div className="trust-d">{t(`pg_about_struct_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_about_values_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_about_values_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="trust-item">
                <div>
                  <div className="trust-t">{t(`pg_about_val_${n}_t`)}</div>
                  <div className="trust-d">{t(`pg_about_val_${n}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
