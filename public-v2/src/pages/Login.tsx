import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { VidaLogo } from '../components/shared/VidaLogo';
import i18n from '../i18n';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const token = await cred.user.getIdTokenResult();
      const role = token.claims.role as string | undefined;
      if (role === 'employee') navigate('/employee');
      else if (role === 'employer_admin') navigate('/employer');
      else if (role === 'ops' || role === 'admin' || role === 'super_admin') navigate('/ops');
      else navigate('/');
    } catch {
      setError('Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) return;
    setResetLoading(true);
    setError('');
    try {
      await sendPasswordResetEmail(auth, email);
      setResetSent(true);
    } catch {
      setError('Error sending reset email');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="nav-logo" style={{ display: 'flex', justifyContent: 'center', marginBottom: 56 }}>
          <VidaLogo />
        </div>

        {forgotMode ? (
          <>
            <h2 style={{ fontFamily: 'var(--df)', fontSize: 40, color: 'var(--t1)', textAlign: 'center', marginBottom: 8, letterSpacing: '-.025em' }}>
              {t('auth_forgot')}
            </h2>
            <p className="auth-sub">{t('auth_forgot_sub')}</p>

            {resetSent ? (
              <div style={{ textAlign: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(36,122,110,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" style={{ width: 28, height: 28 }}>
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
                <p style={{ fontSize: 15, color: 'var(--t2)', marginBottom: 32 }}>{t('auth_reset_sent')}</p>
                <button
                  className="onb-btn secondary"
                  onClick={() => {
                    setForgotMode(false);
                    setResetSent(false);
                  }}
                >
                  {t('auth_back_to_login')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword}>
                <div className="form-group" style={{ marginBottom: 24 }}>
                  <label className="onb-label">{t('auth_email')}</label>
                  <input
                    className="onb-input"
                    type="email"
                    placeholder={t('auth_email_placeholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                {error && <div className="auth-error show">{error}</div>}

                <button className="onb-btn" type="submit" disabled={resetLoading}>
                  {resetLoading ? t('auth_sending_reset') : t('auth_send_reset')}
                </button>

                <div className="auth-footer">
                  <button
                    type="button"
                    onClick={() => {
                      setForgotMode(false);
                      setError('');
                    }}
                    style={{ background: 'none', border: 'none', color: 'var(--brand)', fontWeight: 600, cursor: 'pointer', fontSize: 13, fontFamily: 'var(--db)' }}
                  >
                    {t('auth_back_to_login')}
                  </button>
                </div>
              </form>
            )}
          </>
        ) : (
          <>
            <h2 style={{ fontFamily: 'var(--df)', fontSize: 40, color: 'var(--t1)', textAlign: 'center', marginBottom: 8, letterSpacing: '-.025em' }}>
              {t('auth_welcome')}
            </h2>
            <p className="auth-sub">{t('auth_signin_sub')}</p>

            <form onSubmit={handleSubmit}>
              <div className="form-group" style={{ marginBottom: 24 }}>
                <label className="onb-label">{t('auth_email')}</label>
                <input
                  className="onb-input"
                  type="email"
                  placeholder={t('auth_email_placeholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="onb-label">{t('auth_password')}</label>
                <input
                  className="onb-input"
                  type="password"
                  placeholder={t('auth_password_placeholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <div style={{ textAlign: 'right', marginBottom: 24 }}>
                <button
                  type="button"
                  onClick={() => {
                    setForgotMode(true);
                    setError('');
                  }}
                  style={{ background: 'none', border: 'none', color: 'var(--brand)', fontWeight: 600, cursor: 'pointer', fontSize: 13, fontFamily: 'var(--db)', borderBottom: '1px solid rgba(25,68,69,0.12)', paddingBottom: 1 }}
                >
                  {t('auth_forgot')}
                </button>
              </div>

              {error && <div className="auth-error show">{error}</div>}

              <button className="onb-btn" type="submit" disabled={loading}>
                {loading ? t('auth_signing_in') : t('auth_signin_btn')}
              </button>
            </form>

            <div className="auth-footer">
              {t('auth_no_account')}{' '}
              <Link to="/onboarding">{t('auth_signup_link')}</Link>
            </div>
          </>
        )}

        {/* Language toggle */}
        <div style={{ textAlign: 'center', marginTop: 32 }}>
          <button className="onb-lang" onClick={toggleLang}>
            {t('lang_toggle')}
          </button>
        </div>
      </div>
    </div>
  );
}
