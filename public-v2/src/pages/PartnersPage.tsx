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
      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_part_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_part_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto 44px', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_part_sub')}</p>
            <div style={{ opacity: 0, animation: 'fu .9s ease .55s forwards' }}>
              <Link to="/contact" className="hero-cta">{t('pg_part_cta')}</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Who — 2x2 grid with borders */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_part_who_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_part_who_h')} /></h2>
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
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{t(`pg_part_who_${n}_t`)}</div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.6 }}>{t(`pg_part_who_${n}_d`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How — 2-col lp-grid with sticky left + steps right */}
      <section className="section tinted">
        <div className="wrap">
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv" style={{ position: 'sticky', top: 120 }}>
              <div className="tag">{t('pg_part_how_tag')}</div>
              <h2 className="sh"><RichText html={t('pg_part_how_h')} /></h2>
            </div>
            <div className="steps">
              {[1, 2, 3].map((n) => (
                <div key={n} className={`step rv d${n}`}>
                  <div className="step-n">{n}</div>
                  <div>
                    <div className="step-title">{t(`pg_part_how_${n}_t`)}</div>
                    <div className="step-desc">{t(`pg_part_how_${n}_d`)}</div>
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
          <div className="tag rv">{t('pg_part_ben_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_part_ben_h')} /></h2>
          <div className="metrics rv d2" style={{ marginTop: 48 }}>
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
      <section className="closing">
        <div className="closing-glow" />
        <h2 className="rv"><RichText html={t('pg_part_h1')} /></h2>
        <p className="closing-sub rv d1">{t('pg_part_sub')}</p>
        <Link to="/contact" className="closing-btn rv d2">{t('pg_part_cta')}</Link>
      </section>
    </>
  );
}
