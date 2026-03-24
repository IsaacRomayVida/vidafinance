import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { VidaLogo } from '../components/shared/VidaLogo';

export function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="auth-container">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="nav-logo" style={{ marginBottom: '32px' }}>
          <Link to="/">
            <VidaLogo />
          </Link>
        </div>

        <h1 style={{ fontFamily: 'var(--df)', fontSize: '96px', fontWeight: 400, color: 'var(--t1)', margin: 0, lineHeight: 1 }}>
          {t('error_404')}
        </h1>

        <p style={{ color: 'var(--t2)', fontSize: '18px', marginTop: '16px' }}>
          {t('error_404_message')}
        </p>

        <Link to="/" className="auth-btn" style={{ display: 'block', textDecoration: 'none', marginTop: '32px' }}>
          {t('error_404_home')}
        </Link>
      </div>
    </div>
  );
}
