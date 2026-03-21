import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VidaLogo } from '../shared/VidaLogo';

interface NavbarProps {
  ctaLabel?: string;
  ctaHref?: string;
}

export function Navbar({ ctaLabel, ctaHref = '/onboarding' }: NavbarProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    localStorage.setItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  const cta = ctaLabel || t('nav_get_started');

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <div className="nav-left">
            <div
              className={`hamburger${menuOpen ? ' open' : ''}`}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span /><span /><span />
            </div>
            <Link to="/" className="nav-logo"><VidaLogo /></Link>
            <div className="nav-links">
              <Link to="/employers">{t('nav_employers')}</Link>
              <Link to="/employees">{t('nav_employees')}</Link>
              <Link to="/#trust">{t('nav_trust')}</Link>
              <Link to="/#how">{t('nav_how')}</Link>
            </div>
          </div>
          <div className="nav-right">
            <button className="nav-lang" onClick={toggleLang}>{t('lang_toggle')}</button>
            <Link to="/login" className="nav-login">{t('nav_login')}</Link>
            <Link to={ctaHref} className="nav-cta">{cta}</Link>
          </div>
        </div>
      </nav>
      <div className={`nav-menu${menuOpen ? ' open' : ''}`}>
        <div className="menu-close" onClick={() => setMenuOpen(false)}>&#x2715;</div>
        <Link to="/employers" className="menu-link" onClick={() => setMenuOpen(false)}>{t('nav_employers')}</Link>
        <Link to="/employees" className="menu-link" onClick={() => setMenuOpen(false)}>{t('nav_employees')}</Link>
        <Link to="/#trust" className="menu-link" onClick={() => setMenuOpen(false)}>{t('nav_trust')}</Link>
        <Link to="/#how" className="menu-link" onClick={() => setMenuOpen(false)}>{t('nav_how')}</Link>
        <Link to="/login" className="menu-link" onClick={() => setMenuOpen(false)}>{t('nav_login')}</Link>
        <Link to={ctaHref} className="menu-link" onClick={() => setMenuOpen(false)}>{cta}</Link>
        <button className="menu-link" onClick={() => { toggleLang(); setMenuOpen(false); }}>{t('lang_toggle')}</button>
      </div>
    </>
  );
}
