import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PartnersPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_part_badge')}`);

  return (
    <>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_part_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_part_h1')} /></h1>
          <p className="sub rv d2">{t('pg_part_sub')}</p>
          <Link to="/contact" className="btn rv d3">{t('pg_part_cta')}</Link>
        </div>
      </section>

      {/* Who */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_part_who_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_part_who_h')} /></h2>
          <div className="trust-grid rv d2">
            {[1, 2, 3, 4].map((i) => (
              <div className="trust-item" key={i}>
                <div>
                  <div className="trust-t">{t(`pg_part_who_${i}_t`)}</div>
                  <div className="trust-d">{t(`pg_part_who_${i}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_part_how_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_part_how_h')} /></h2>
          <div className="steps">
            {[1, 2, 3].map((i) => (
              <div className={`step rv d${i}`} key={i}>
                <div className="step-n">{i}</div>
                <div>
                  <div className="trust-t">{t(`pg_part_how_${i}_t`)}</div>
                  <div className="trust-d">{t(`pg_part_how_${i}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_part_ben_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_part_ben_h')} /></h2>
          <div className="metrics rv d2">
            {[1, 2, 3, 4].map((i) => (
              <div className="metric" key={i}>
                <div className="metric-v">{t(`pg_part_ben_${i}_v`)}</div>
                <div className="metric-l">{t(`pg_part_ben_${i}_l`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="section">
        <div className="wrap text-center">
          <Link to="/contact" className="btn rv">{t('pg_part_cta')}</Link>
        </div>
      </section>
    </>
  );
}
