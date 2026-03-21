import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-teal-950 px-6 text-center">
      <h1 className="text-6xl font-bold text-white">404</h1>
      <p className="mt-4 text-lg text-teal-300">{t('not_found_message', 'Page not found')}</p>
      <Link
        to="/"
        className="mt-6 rounded-lg bg-gold-500 px-6 py-3 text-sm font-medium text-teal-950 hover:bg-gold-400"
      >
        {t('not_found_home', 'Go home')}
      </Link>
    </div>
  );
}
