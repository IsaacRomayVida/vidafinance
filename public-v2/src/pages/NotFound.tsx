import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VidaLogo } from '../components/shared/VidaLogo';

export function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="auth-container">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="nav-logo">
          <Link to="/">
            <VidaLogo />
          </Link>
        </div>

        <h1 style={{ fontFamily: 'var(--df)', fontSize: '4rem', margin: '24px 0 8px' }}>
          {t('error_404')}
        </h1>
        <p className="auth-sub">{t('error_404_message')}</p>

        <Link to="/" className="auth-btn" style={{ display: 'inline-block', marginTop: 24 }}>
          {t('error_404_home')}
        </Link>
      </div>
    </div>
  );
}
