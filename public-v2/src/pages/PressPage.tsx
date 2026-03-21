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
      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_press_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_press_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_press_sub')}</p>
          </div>
        </div>
      </section>

      {/* Press Kit — steps with SVG icons */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_press_kit_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_press_kit_h')} /></h2>
          <div className="steps" style={{ marginTop: 56 }}>
            <div className="step rv d2">
              <div className="step-n">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                </svg>
              </div>
              <div>
                <div className="step-title">{t('pg_press_kit_1_t')}</div>
                <div className="step-desc">{t('pg_press_kit_1_d')}</div>
              </div>
            </div>
            <div className="step rv d3">
              <div className="step-n">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8" />
                </svg>
              </div>
              <div>
                <div className="step-title">{t('pg_press_kit_2_t')}</div>
                <div className="step-desc">{t('pg_press_kit_2_d')}</div>
              </div>
            </div>
            <div className="step rv d4">
              <div className="step-n">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </div>
              <div>
                <div className="step-title">{t('pg_press_kit_3_t')}</div>
                <div className="step-desc">{t('pg_press_kit_3_d')}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Press Contact + Brand Guide — 2-col lp-grid */}
      <section className="section tinted">
        <div className="wrap">
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv">
              <div className="tag">{t('pg_press_contact_tag')}</div>
              <p className="sp" style={{ marginTop: 8 }}>{t('pg_press_contact_p')}</p>
              <a href={`mailto:${t('pg_press_contact_email')}`} style={{ display: 'inline-block', marginTop: 16, fontSize: 17, fontWeight: 700, color: 'var(--t1)', borderBottom: '2px solid var(--brand)', paddingBottom: 2 }}>
                {t('pg_press_contact_email')}
              </a>
            </div>
            <div className="rv d1">
              <div className="tag">{t('pg_press_brand_tag')}</div>
              <h2 className="sh" style={{ marginBottom: 36 }}><RichText html={t('pg_press_brand_h')} /></h2>
              <div style={{ borderTop: '1px solid rgba(25,68,69,0.04)' }}>
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} style={{ padding: '24px 0', borderBottom: n < 4 ? '1px solid rgba(25,68,69,0.04)' : undefined }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>{t(`pg_press_brand_${n}_t`)}</div>
                    <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6 }}>{t(`pg_press_brand_${n}_d`)}</div>
                    {n === 2 && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <span style={{ width: 32, height: 32, borderRadius: 8, background: '#194445', display: 'block' }} />
                        <span style={{ fontSize: 11, color: 'var(--t3)', alignSelf: 'center' }}>#194445</span>
                      </div>
                    )}
                    {n === 3 && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <span style={{ width: 32, height: 32, borderRadius: 8, background: '#C9A84C', display: 'block' }} />
                        <span style={{ fontSize: 11, color: 'var(--t3)', alignSelf: 'center' }}>#C9A84C</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
