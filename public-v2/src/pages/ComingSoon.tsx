import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { RichText } from '../components/shared/RichText';
import { FunpayLogo } from '../components/shared/FunpayLogo';
import { ComingSoonForm } from '../components/marketing/ComingSoonForm';
import { SplashIntro } from '../components/marketing/SplashIntro';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { safeSetItem } from '../lib/safeStorage';

const EMP_ITEMS = ['1', '2', '3'] as const;
const WRK_ITEMS = ['1', '2', '3'] as const;
const TRUST_ITEMS = ['1', '2', '3'] as const;

export function ComingSoon() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('cs_meta_title'));

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    safeSetItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  return (
    <div className="cs-page">
      <SplashIntro />
      <Helmet>
        <title>{t('cs_meta_title')}</title>
        <meta name="description" content={t('cs_meta_desc')} />
        <meta property="og:title" content={t('cs_meta_title')} />
        <meta property="og:description" content={t('cs_meta_desc')} />
        <meta property="og:type" content="website" />
      </Helmet>

      <a href="#contacto" className="skip-link">{t('a11y_skip_content')}</a>

      {/* Minimal header */}
      <header className="cs-header">
        <div className="wrap cs-header-inner">
          <FunpayLogo />
          <button
            type="button"
            onClick={toggleLang}
            className="cs-lang-btn"
            aria-label={t('a11y_lang_toggle')}
          >
            {t('lang_toggle')}
          </button>
        </div>
      </header>

      <main>
        {/* Hero — cinematic video splash */}
        <section className="hero cs-hero cs-hero--video">
          <div className="hero-video-wrap" aria-hidden="true">
            <video
              className="hero-video"
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster="/video/hero-poster.jpg"
            >
              <source src="/video/hero.mp4" type="video/mp4" />
            </video>
            <div className="cs-hero-scrim" />
          </div>
          <div className="wrap text-center cs-hero-inner">
            <span className="cs-badge">
              <span className="cs-badge-dot" aria-hidden="true" />
              {t('cs_badge')}
            </span>
            <h1 className="cs-h1"><RichText html={t('cs_h1')} /></h1>
            <p className="cs-sub">{t('cs_sub')}</p>
            <a href="#contacto" className="hero-cta cs-hero-cta">
              {t('cs_hero_cta')}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </a>
            <p className="cs-hero-note">{t('cs_hero_cta_note')}</p>
          </div>
        </section>

        {/* For companies */}
        <section className="section cs-section">
          <div className="wrap">
            <div className="tag">{t('cs_emp_tag')}</div>
            <h2 className="cs-h2">{t('cs_emp_h2')}</h2>
            <p className="cs-lead">{t('cs_emp_p')}</p>
            <div className="cs-grid">
              {EMP_ITEMS.map((n) => (
                <div className="cs-card" key={`emp-${n}`}>
                  <div className="cs-card-t">{t(`cs_emp_${n}_t`)}</div>
                  <div className="cs-card-d">{t(`cs_emp_${n}_d`)}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Showcase — looping video with text overlay */}
        <div className="cs-showcase cs-showcase--video">
          <video
            className="cs-showcase-video"
            autoPlay
            muted
            loop
            playsInline
            preload="none"
            poster="/video/showcase-poster.jpg"
            aria-hidden="true"
          >
            <source src="/video/showcase.mp4" type="video/mp4" />
          </video>
          <div className="cs-showcase-scrim" aria-hidden="true" />
          <div className="cs-showcase-overlay">
            <p className="cs-showcase-kicker">{t('cs_showcase_kicker')}</p>
            <h2 className="cs-showcase-title"><RichText html={t('cs_showcase_title')} /></h2>
            <p className="cs-showcase-sub">{t('cs_showcase_sub')}</p>
          </div>
        </div>

        {/* For workers */}
        <section className="section tinted cs-section">
          <div className="wrap">
            <div className="tag">{t('cs_wrk_tag')}</div>
            <h2 className="cs-h2">{t('cs_wrk_h2')}</h2>
            <p className="cs-lead">{t('cs_wrk_p')}</p>
            <div className="cs-grid">
              {WRK_ITEMS.map((n) => (
                <div className="cs-card" key={`wrk-${n}`}>
                  <div className="cs-card-t">{t(`cs_wrk_${n}_t`)}</div>
                  <div className="cs-card-d">{t(`cs_wrk_${n}_d`)}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Trust / regulatory */}
        <section className="section cs-section">
          <div className="wrap">
            <div className="tag">{t('cs_trust_tag')}</div>
            <div className="cs-grid">
              {TRUST_ITEMS.map((n) => (
                <div className="cs-card" key={`trust-${n}`}>
                  <div className="cs-card-t">{t(`cs_trust_${n}_t`)}</div>
                  <div className="cs-card-d">{t(`cs_trust_${n}_d`)}</div>
                </div>
              ))}
            </div>
            <p className="cs-condusef">
              <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">
                {t('cs_trust_condusef')}
              </a>
            </p>
          </div>
        </section>

        {/* Contact form */}
        <section className="section tinted cs-section" id="contacto">
          <div className="wrap cs-form-wrap">
            <h2 className="cs-h2">{t('cs_form_h2')}</h2>
            <p className="cs-lead">{t('cs_form_p')}</p>
            <ComingSoonForm />
          </div>
        </section>
      </main>

      {/* Minimal footer */}
      <footer className="cs-footer">
        <div className="wrap cs-footer-inner">
          <div className="cs-footer-brand">
            <FunpayLogo variant="footer" />
            <p className="cs-footer-tag">{t('cs_footer_tagline')}</p>
          </div>
          <div className="cs-footer-links">
            <a href="#contacto">{t('cs_footer_contact')}</a>
            <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">CONDUSEF</a>
            <button type="button" onClick={toggleLang} className="cs-lang-btn" aria-label={t('a11y_lang_toggle')}>
              {t('lang_toggle')}
            </button>
          </div>
          <div className="cs-footer-legal">
            <span>&copy; 2026 Funpay. {t('cs_footer_rights')}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
