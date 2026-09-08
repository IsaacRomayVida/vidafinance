import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FunpayLogo } from '../shared/FunpayLogo';
import { safeSetItem } from '../../lib/safeStorage';

interface NavbarProps {
  ctaLabel?: string;
  ctaHref?: string;
}

/**
 * Minimal nav: Doto FUNPAY brand mark, Urbanist links, and exactly one
 * green pill — "Comenzar". "Iniciar sesión" is an ink ghost. The bar is a
 * frosted cream pill that sticks inside the page's 10px gutter.
 */
export function Navbar({ ctaLabel, ctaHref = '/onboarding' }: NavbarProps) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

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
      <nav className="mk-nav" aria-label={t('a11y_menu')}>
        <div className="mk-nav-bar">
          <div className="mk-nav-left">
            <Link to="/" className="mk-brand"><FunpayLogo /></Link>
            <div className="mk-nav-links">
              <Link to="/employees" className="mk-nav-link">{t('nav_employees')}</Link>
              <Link to="/employers" className="mk-nav-link">{t('nav_employers')}</Link>
              <Link to="/#how" className="mk-nav-link">{t('nav_how')}</Link>
              <Link to="/#trust" className="mk-nav-link">{t('nav_trust')}</Link>
            </div>
          </div>
          <div className="mk-nav-right">
            <button type="button" className="mk-icon-btn" aria-label={t('a11y_lang_toggle')} onClick={toggleLang}>{t('lang_toggle')}</button>
            <Link to="/login" className="mk-btn ghost sm mk-nav-login">{t('nav_login')}</Link>
            <Link to={ctaHref} className="mk-btn cta sm">{cta}</Link>
            <button
              ref={hamburgerRef}
              type="button"
              className="mk-hamburger"
              aria-label={t('a11y_open_menu')}
              aria-expanded={menuOpen}
              aria-controls="nav-mobile-menu"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <span /><span /><span />
            </button>
          </div>
        </div>
      </nav>
      <div
        id="nav-mobile-menu"
        ref={menuRef}
        className={`mk-menu${menuOpen ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('a11y_menu')}
        inert={!menuOpen}
      >
        <button
          type="button"
          className="mk-menu-close"
          aria-label={t('a11y_close_menu')}
          onClick={() => setMenuOpen(false)}
        >
          &#x2715;
        </button>
        <span className="mk-menu-label dot">FunPay</span>
        <Link to="/employees" onClick={() => setMenuOpen(false)}>{t('nav_employees')}</Link>
        <Link to="/employers" onClick={() => setMenuOpen(false)}>{t('nav_employers')}</Link>
        <Link to="/#how" onClick={() => setMenuOpen(false)}>{t('nav_how')}</Link>
        <Link to="/#trust" onClick={() => setMenuOpen(false)}>{t('nav_trust')}</Link>
        <Link to="/login" onClick={() => setMenuOpen(false)}>{t('nav_login')}</Link>
        <Link to={ctaHref} className="mk-btn cta mk-menu-cta" onClick={() => setMenuOpen(false)}>{cta}</Link>
        <button type="button" className="mk-menu-link" aria-label={t('a11y_lang_toggle')} onClick={() => { toggleLang(); setMenuOpen(false); }}>{t('lang_toggle')}</button>
      </div>
    </>
  );
}
