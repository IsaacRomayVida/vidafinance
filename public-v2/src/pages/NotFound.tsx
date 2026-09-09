import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FunpayLogo } from '../components/shared/FunpayLogo';

export function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="mk-auth">
      <div className="mk-auth-board">
        <div className="mk-auth-head">
          <Link to="/" className="nav-logo"><FunpayLogo /></Link>
          <span className="dot">{t('error_404')}</span>
        </div>
        <h1 className="mk-auth-title">{t('error_404_message')}</h1>
        <p className="mk-auth-sub">{t('error_404_sub')}</p>
        <Link to="/" className="mk-btn block">{t('error_404_home')}</Link>
      </div>
    </div>
  );
}
