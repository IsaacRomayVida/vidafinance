import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { PageTransition } from '../ui/PageTransition';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { safeSetItem } from '../../lib/safeStorage';

/**
 * The borrower shell: one cream→sage board, a Doto brand mark, two Doto nav
 * pills (the active one goes solid white — the only contrast jump in the
 * chrome) and the language / sign-out tools. No sidebar, no header bar: the
 * screen itself is the surface.
 */
export function EmployeeLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="bo-shell">
      <header className="bo-top">
        <Link to="/employee" className="bo-brand dot" aria-label="FunPay">
          Funpay
        </Link>
        <nav className="bo-nav" aria-label={t('dash_home_label')}>
          {[
            { path: '/employee', label: t('dash_home_label') },
            { path: '/employee/loans', label: t('dash_my_loans') },
          ].map(({ path, label }) => (
            <Link
              key={path}
              to={path}
              className={`dot${isActive(path) ? ' on' : ''}`}
              aria-current={isActive(path) ? 'page' : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="bo-tools">
          <button
            type="button"
            className="bo-tool"
            aria-label={t('a11y_lang_toggle')}
            onClick={() => {
              const next = i18n.language === 'es' ? 'en' : 'es';
              i18n.changeLanguage(next);
              safeSetItem('vida_lang', next);
            }}
          >
            {i18n.language === 'es' ? 'EN' : 'ES'}
          </button>
          <button type="button" className="bo-tool" onClick={handleSignOut}>
            {t('dash_signout')}
          </button>
        </div>
      </header>
      <main className="bo-main">
        <PageTransition><Outlet /></PageTransition>
      </main>
    </div>
  );
}
