import { Outlet, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function MarketingLayout() {
  const { t, i18n } = useTranslation();

  const toggleLang = () => {
    i18n.changeLanguage(i18n.language === 'es' ? 'en' : 'es');
  };

  return (
    <div className="min-h-screen bg-white text-teal-900">
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b border-teal-100 bg-white/95 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-xl font-bold tracking-tight text-teal-900">
            VIDA
          </Link>

          <div className="hidden items-center gap-6 text-sm font-medium md:flex">
            <Link to="/employers" className="text-teal-700 hover:text-teal-900">
              {t('nav_employers')}
            </Link>
            <Link to="/employees" className="text-teal-700 hover:text-teal-900">
              {t('nav_employees')}
            </Link>
            <Link to="/about" className="text-teal-700 hover:text-teal-900">
              {t('ft_about')}
            </Link>
            <Link to="/contact" className="text-teal-700 hover:text-teal-900">
              {t('nav_contact')}
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleLang}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-teal-700 hover:bg-teal-50"
            >
              {t('lang_toggle')}
            </button>
            <Link
              to="/login"
              className="text-sm font-medium text-teal-700 hover:text-teal-900"
            >
              {t('nav_login')}
            </Link>
            <Link
              to="/get-started"
              className="rounded-lg bg-teal-900 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              {t('nav_get_started')}
            </Link>
          </div>
        </nav>
      </header>

      {/* Main Content */}
      <main>
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-teal-100 bg-teal-950 px-6 py-12 text-teal-300">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 grid gap-8 md:grid-cols-3">
            <div>
              <p className="mb-2 text-lg font-bold text-white">VIDA</p>
              <p className="text-sm">{t('ft_tagline')}</p>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-white">{t('ft_platform')}</p>
              <div className="flex flex-col gap-1 text-sm">
                <Link to="/employers" className="hover:text-white">{t('nav_employers')}</Link>
                <Link to="/employees" className="hover:text-white">{t('nav_employees')}</Link>
                <Link to="/partners" className="hover:text-white">{t('nav_partners')}</Link>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-white">{t('ft_company')}</p>
              <div className="flex flex-col gap-1 text-sm">
                <Link to="/about" className="hover:text-white">{t('ft_about')}</Link>
                <Link to="/security" className="hover:text-white">{t('ft_security')}</Link>
                <Link to="/privacy" className="hover:text-white">{t('ft_privacy')}</Link>
                <Link to="/terms" className="hover:text-white">{t('ft_terms')}</Link>
              </div>
            </div>
          </div>
          <p className="text-xs text-teal-500">
            &copy; {new Date().getFullYear()} VIDA Holding AG. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
