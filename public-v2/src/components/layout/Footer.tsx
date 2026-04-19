import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VidaLogo } from '../shared/VidaLogo';
import { safeSetItem } from '../../lib/safeStorage';

export function Footer() {
  const { t, i18n } = useTranslation();

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    safeSetItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="ft-top">
          <div className="ft-brand">
            <div className="ft-logo"><VidaLogo variant="footer" /></div>
            <p className="ft-tag">{t('ft_tagline')}</p>
          </div>
          <div className="ft-col">
            <div className="ft-h">{t('ft_platform')}</div>
            <Link to="/employers">{t('nav_employers')}</Link>
            <Link to="/employees">{t('nav_employees')}</Link>
            <Link to="/partners">{t('nav_partners')}</Link>
            <Link to="/investors">{t('nav_investors')}</Link>
          </div>
          <div className="ft-col">
            <div className="ft-h">{t('ft_company')}</div>
            <Link to="/about">{t('ft_about')}</Link>
            <Link to="/security">{t('ft_security')}</Link>
            <Link to="/privacy">{t('ft_privacy')}</Link>
            <Link to="/terms">{t('ft_terms')}</Link>
          </div>
          <div className="ft-col">
            <div className="ft-h">{t('ft_connect')}</div>
            <Link to="/contact">{t('nav_contact')}</Link>
            <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <Link to="/press">{t('ft_press')}</Link>
          </div>
        </div>
        <div className="ft-btm">
          <span>&copy; 2026 VIDA</span>
          <div className="ft-btm-links">
            <button onClick={toggleLang} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
              {t('lang_toggle')}
            </button>
            <Link to="/privacy">{t('ft_privacy_policy')}</Link>
            <Link to="/terms">{t('ft_terms_service')}</Link>
            <span style={{ color: 'rgba(255,255,255,.3)' }}>&middot;</span>
            <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener noreferrer">CONDUSEF</a>
            <span style={{ color: 'rgba(255,255,255,.3)' }}>&middot;</span>
            <a href="tel:018009998080">01 800 999 8080</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
