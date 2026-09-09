import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FunpayLogo } from '../shared/FunpayLogo';
import { safeSetItem } from '../../lib/safeStorage';

/** Footer on an ink board; CONDUSEF and lender lines as one-line disclosures. */
export function Footer() {
  const { t, i18n } = useTranslation();

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    safeSetItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  return (
    <footer className="mk-footer">
      <div className="mk-inner">
        <div className="mk-ft-top">
          <div className="mk-ft-brand">
            <FunpayLogo variant="footer" />
            <p className="mk-ft-tag">{t('ft_tagline')}</p>
          </div>
          <div className="mk-ft-col">
            <div className="mk-ft-h dot">{t('ft_platform')}</div>
            <Link to="/employees">{t('nav_employees')}</Link>
            <Link to="/employers">{t('nav_employers')}</Link>
            <Link to="/partners">{t('nav_partners')}</Link>
            <Link to="/investors">{t('nav_investors')}</Link>
          </div>
          <div className="mk-ft-col">
            <div className="mk-ft-h dot">{t('ft_company')}</div>
            <Link to="/about">{t('ft_about')}</Link>
            <Link to="/security">{t('ft_security')}</Link>
            <Link to="/privacy">{t('ft_privacy')}</Link>
            <Link to="/terms">{t('ft_terms')}</Link>
          </div>
          <div className="mk-ft-col">
            <div className="mk-ft-h dot">{t('ft_connect')}</div>
            <Link to="/contact">{t('nav_contact')}</Link>
            <Link to="/press">{t('ft_press')}</Link>
            <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer">LinkedIn</a>
          </div>
        </div>

        <div className="mk-ft-disclose">
          <span>{t('ft_lender_line')}</span>
          <span>
            {t('ft_condusef_line')}{' '}
            <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">condusef.gob.mx</a>
            {' · '}
            <a href="tel:018009998080">800 999 8080</a>
          </span>
        </div>

        <div className="mk-ft-btm">
          <span>&copy; 2026 FunPay</span>
          <div className="mk-ft-btm-links">
            <button type="button" className="mk-icon-btn" onClick={toggleLang} aria-label={t('a11y_lang_toggle')}>
              {t('lang_toggle')}
            </button>
            <Link to="/privacy">{t('ft_privacy_policy')}</Link>
            <Link to="/terms">{t('ft_terms_service')}</Link>
            <a href="https://suena.ch/en" target="_blank" rel="noopener noreferrer" className="mk-ft-venture">
              <span>{t('ft_venture')}</span>
              <b>Suena</b>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
