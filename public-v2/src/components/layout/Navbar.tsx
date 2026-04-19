import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VidaLogo } from '../shared/VidaLogo';
import { safeSetItem } from '../../lib/safeStorage';

interface NavbarProps {
  ctaLabel?: string;
  ctaHref?: string;
}

export function Navbar({ ctaLabel, ctaHref = '/onboarding' }: NavbarProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
    safeSetItem('vida_lang', next);
    document.documentElement.lang = next;
  };

  const cta = ctaLabel || t('nav_get_started');

  return (
    <>
      <nav className={`nav${scrolled ? " nav-scrolled" : " nav-transparent"}`}>
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
        <Link to="/employers" className="menu-link" style={{ animationDelay: '0.05s' }} onClick={() => setMenuOpen(false)}>{t('nav_employers')}</Link>
        <Link to="/employees" className="menu-link" style={{ animationDelay: '0.1s' }} onClick={() => setMenuOpen(false)}>{t('nav_employees')}</Link>
        <Link to="/#trust" className="menu-link" style={{ animationDelay: '0.15s' }} onClick={() => setMenuOpen(false)}>{t('nav_trust')}</Link>
        <Link to="/#how" className="menu-link" style={{ animationDelay: '0.2s' }} onClick={() => setMenuOpen(false)}>{t('nav_how')}</Link>
        <Link to="/login" className="menu-link" style={{ animationDelay: '0.25s' }} onClick={() => setMenuOpen(false)}>{t('nav_login')}</Link>
        <Link to={ctaHref} className="menu-link" style={{ animationDelay: '0.3s' }} onClick={() => setMenuOpen(false)}>{cta}</Link>
        <button className="menu-link" style={{ animationDelay: '0.35s' }} onClick={() => { toggleLang(); setMenuOpen(false); }}>{t('lang_toggle')}</button>
      </div>
    </>
  );
}
