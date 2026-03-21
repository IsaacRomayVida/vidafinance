import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PressPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_press_badge')}`);

  return (
    <>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_press_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_press_h1')} /></h1>
          <p className="sub rv d2">{t('pg_press_sub')}</p>
        </div>
      </section>

      {/* Press Kit */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_press_kit_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_press_kit_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3].map((i) => (
              <div className="trust-item" key={i}>
                <div>
                  <div className="trust-t">{t(`pg_press_kit_${i}_t`)}</div>
                  <div className="trust-d">{t(`pg_press_kit_${i}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Press Contact */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_press_contact_tag')}</div>
          <p className="sp rv d1">{t('pg_press_contact_p')}</p>
          <a href={`mailto:${t('pg_press_contact_email')}`} className="btn rv d2">
            {t('pg_press_contact_email')}
          </a>
        </div>
      </section>

      {/* Brand Guide */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_press_brand_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_press_brand_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((i) => (
              <div className="trust-item" key={i}>
                <div>
                  <div className="trust-t">{t(`pg_press_brand_${i}_t`)}</div>
                  <div className="trust-d">{t(`pg_press_brand_${i}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
