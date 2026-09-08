import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { PageTransition } from '../ui/PageTransition';
import { useTranslation } from 'react-i18next';
import { signOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { safeSetItem } from '../../lib/safeStorage';

/**
 * Employer (HR) shell — the dark ops board. The brand mark and the tag-pill
 * navigation live here so every employer page sits inside the same board;
 * the current section is the one tag that carries the green dot.
 */
export function EmployerLayout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut(auth);
    navigate('/');
  };

  const isActive = (path: string) => location.pathname === path;

  const tabs = [
    { path: '/employer', label: t('ops_nav_panel') },
    { path: '/employer/employees', label: t('ops_nav_employees') },
    { path: '/employer/deductions', label: t('ops_nav_deductions') },
    { path: '/employer/payroll', label: t('ops_nav_payroll') },
    { path: '/employer/analytics', label: t('ops_nav_analytics') },
  ];

  return (
    <div className="ops-shell">
      <a href="#ops-main" className="ops-skip">{t('a11y_skip_content')}</a>
      <header className="ops-top">
        <Link to="/employer" className="ops-brand">
          <b aria-hidden="true">F</b>FunPay <span>· {t('ops_side_employer')}</span>
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
        <PageTransition><Outlet /></PageTransition>
      </main>
    </div>
  );
}
