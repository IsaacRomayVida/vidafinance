import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { safeSetItem } from '../../lib/safeStorage';

/**
 * Aliados operations shell — the dark ops board. Brand mark plus tag-pill
 * navigation; the current section is the one tag with the green dot.
 */
export function AdminLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path || (path === '/ops/review-queue' && location.pathname.startsWith('/ops/review-queue/'));

  const tabs = [
    { path: '/ops', label: t('ops_nav_panel') },
    { path: '/ops/review-queue', label: t('ops_nav_review') },
    { path: '/ops/employers', label: t('ops_nav_employers') },
    { path: '/ops/portfolio', label: t('ops_nav_portfolio') },
    { path: '/ops/alerts', label: t('ops_nav_alerts') },
    { path: '/ops/health', label: t('ops_nav_health') },
  ];

  return (
    <div className="ops-shell">
      <a href="#ops-main" className="ops-skip">{t('a11y_skip_content')}</a>
      <header className="ops-top">
        <Link to="/ops" className="ops-brand">
          <b aria-hidden="true">F</b>FunPay <span>· {t('ops_side_ops')}</span>
        </Link>
        <nav className="ops-tags" aria-label={t('ops_nav_label')}>
          {tabs.map(({ path, label }) => {
            const on = isActive(path);
            return (
              <Link
                key={path}
                to={path}
                className={`ops-tag${on ? ' on' : ''}`}
                aria-current={on ? 'page' : undefined}
              >
                {on && <i aria-hidden="true" />}
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="ops-top-actions">
          <button
            type="button"
            className="ops-tag"
            aria-label={t('a11y_lang_toggle')}
            onClick={() => { const next = i18n.language === 'es' ? 'en' : 'es'; i18n.changeLanguage(next); safeSetItem('vida_lang', next); }}
          >
            {i18n.language === 'es' ? 'EN' : 'ES'}
          </button>
          <button type="button" className="ops-link" onClick={handleSignOut}>
            {t('dash_signout')}
          </button>
        </div>
      </header>
      <main id="ops-main" className="ops-main">
        <Outlet />
      </main>
    </div>
  );
}
