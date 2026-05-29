import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FunpayLogo } from '../shared/FunpayLogo';
import { safeSetItem } from '../../lib/safeStorage';

interface NavbarProps {
  ctaLabel?: string;
  ctaHref?: string;
}

export function Navbar({ ctaLabel, ctaHref = '/onboarding' }: NavbarProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Mobile menu: lock body scroll, trap focus, and close on Escape.
  useEffect(() => {
    if (!menuOpen) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const menu = menuRef.current;
    const getFocusable = () =>
      menu
        ? Array.from(
            menu.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];

    getFocusable()[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      hamburgerRef.current?.focus();
    };
  }, [menuOpen]);

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
            <button
              ref={hamburgerRef}
              type="button"
              className={`hamburger${menuOpen ? ' open' : ''}`}
              aria-label={t('a11y_open_menu')}
              aria-expanded={menuOpen}
              aria-controls="nav-mobile-menu"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span /><span /><span />
            </button>
            <Link to="/" className="nav-logo"><FunpayLogo /></Link>
            <div className="nav-links">
              <Link to="/employers">{t('nav_employers')}</Link>
              <Link to="/employees">{t('nav_employees')}</Link>
              <Link to="/#trust">{t('nav_trust')}</Link>
              <Link to="/#how">{t('nav_how')}</Link>
            </div>
          </div>
          <div className="nav-right">
            <button className="nav-lang" aria-label={t('a11y_lang_toggle')} onClick={toggleLang}>{t('lang_toggle')}</button>
            <Link to="/login" className="nav-login">{t('nav_login')}</Link>
            <Link to={ctaHref} className="nav-cta">{cta}</Link>
          </div>
        </div>
      </nav>
      <div
        id="nav-mobile-menu"
        ref={menuRef}
        className={`nav-menu${menuOpen ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav_get_started')}
        inert={!menuOpen}
      >
        <button
          type="button"
          className="menu-close"
          aria-label={t('a11y_close_menu')}
          onClick={() => setMenuOpen(false)}
        >
          &#x2715;
        </button>
        <Link to="/employers" className="menu-link" style={{ animationDelay: '0.05s' }} onClick={() => setMenuOpen(false)}>{t('nav_employers')}</Link>
        <Link to="/employees" className="menu-link" style={{ animationDelay: '0.1s' }} onClick={() => setMenuOpen(false)}>{t('nav_employees')}</Link>
        <Link to="/#trust" className="menu-link" style={{ animationDelay: '0.15s' }} onClick={() => setMenuOpen(false)}>{t('nav_trust')}</Link>
        <Link to="/#how" className="menu-link" style={{ animationDelay: '0.2s' }} onClick={() => setMenuOpen(false)}>{t('nav_how')}</Link>
        <Link to="/login" className="menu-link" style={{ animationDelay: '0.25s' }} onClick={() => setMenuOpen(false)}>{t('nav_login')}</Link>
        <Link to={ctaHref} className="menu-link" style={{ animationDelay: '0.3s' }} onClick={() => setMenuOpen(false)}>{cta}</Link>
        <button className="menu-link" aria-label={t('a11y_lang_toggle')} style={{ animationDelay: '0.35s' }} onClick={() => { toggleLang(); setMenuOpen(false); }}>{t('lang_toggle')}</button>
      </div>
    </>
  );
}
