import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { Board, BoardHead, Statement } from '../components/marketing/Board';
import { FunpayLogo } from '../components/shared/FunpayLogo';
import { ComingSoonForm } from '../components/marketing/ComingSoonForm';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { safeSetItem } from '../lib/safeStorage';

/**
 * The funpay-ui-direction pre-launch page from 8f389bf (PR #626): a single
 * cream board with the statement headline, one green pill, and the sign-up
 * form beneath.
 *
 * ON HOLD (not wired into App.tsx): the business asked for the previous
 * landing back on the public site for now. `pages/ComingSoon.tsx` (the
 * page App.tsx actually renders for VITE_LAUNCH_MODE=coming-soon, the
 * production default) is the pre-redesign page instead. This component is
 * kept working and side by side for when funpay-ui is ready to launch here
 * too — to bring it back, change the `./pages/ComingSoon` lazy import in
 * App.tsx to `./pages/ComingSoonRedesign` (and re-point the `export { m.ComingSoon }`
 * accessor to `m.ComingSoonRedesign`). No env var/build flag needed either way.
 */
export function ComingSoonRedesign() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('cs_meta_title'));

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    safeSetItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  return (
    <div className="mk-page">
      <Helmet>
        <title>{t('cs_meta_title')}</title>
        <meta name="description" content={t('cs_meta_desc')} />
        <meta property="og:title" content={t('cs_meta_title')} />
        <meta property="og:description" content={t('cs_meta_desc')} />
        <meta property="og:type" content="website" />
      </Helmet>

      <a href="#contacto" className="skip-link">{t('a11y_skip_content')}</a>

      <main>
        <Board tone="paper" style={{ minHeight: 'calc(100vh - 20px)', marginBottom: 0 }}>
          <div className="mk-cs-head">
            <FunpayLogo />
            <button type="button" onClick={toggleLang} className="mk-icon-btn" aria-label={t('a11y_lang_toggle')}>
              {t('lang_toggle')}
            </button>
          </div>

          <span className="mk-kicker dot">{t('cs_badge')}</span>
          <Statement html={t('cs_h1')} lead={t('cs_sub')}>
            <div className="mk-actions">
              <a href="#contacto" className="mk-btn cta">{t('cs_hero_cta')}</a>
            </div>
            <p className="mk-disclose">{t('cs_hero_cta_note')}</p>
          </Statement>

          <div className="mk-cs-form" id="contacto">
            <BoardHead kicker={t('cs_form_tag')} title={t('cs_form_h2')} lead={t('cs_form_p')} />
            <div className="mk-gap-sm" />
            <ComingSoonForm />
          </div>

          <div className="mk-cs-foot">
            <span>&copy; 2026 FunPay · {t('cs_footer_tagline')}</span>
            <span>
              <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">CONDUSEF</a>
              {' · '}
              <a href="https://suena.ch/en" target="_blank" rel="noopener noreferrer">{t('ft_venture')} Suena</a>
            </span>
          </div>
        </Board>
      </main>
    </div>
  );
}
