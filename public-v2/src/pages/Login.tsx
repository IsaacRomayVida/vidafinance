import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  type AuthError,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { VidaLogo } from '../components/shared/VidaLogo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function mapAuthError(code: string): string {
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'auth_error_wrong_password';
    case 'auth/user-not-found':
      return 'auth_error_user_not_found';
    case 'auth/too-many-requests':
      return 'auth_error_too_many_requests';
    case 'auth/invalid-email':
      return 'auth_error_invalid_email';
    default:
      return 'auth_error_generic';
  }
}

export function Login() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  useDocumentTitle(`VIDA — ${t('nav_login')}`);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [mode, setMode] = useState<'login' | 'forgot'>('login');

  const toggleLang = () => {
    const next = i18n.language === 'es' ? 'en' : 'es';
    i18n.changeLanguage(next);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);

      // Check email verification
      if (!cred.user.emailVerified) {
        await sendEmailVerification(cred.user);
        setInfo(t('auth_verify_email'));
        await auth.signOut();
        setLoading(false);
        return;
      }

      // Role-based redirect: check custom claims first, then Firestore.
      // Force-refresh to pick up recently-set custom claims.
      const token = await cred.user.getIdTokenResult(true);
      const role = token.claims.role as string | undefined;

      if (role === 'admin' || role === 'super_admin') {
        navigate('/ops', { replace: true });
      } else if (role === 'ops') {
        navigate('/ops', { replace: true });
      } else if (role === 'employer_admin') {
        navigate('/employer', { replace: true });
      } else if (role === 'employee') {
        navigate('/employee', { replace: true });
      } else {
        // Fallback: check Firestore employers collection, then users collection
        const employerDoc = await getDoc(doc(db, 'employers', cred.user.uid));
        if (employerDoc.exists()) {
          navigate('/employer', { replace: true });
        } else {
          const userDoc = await getDoc(doc(db, 'users', cred.user.uid));
          const userRole = userDoc.exists() ? userDoc.data()?.role : undefined;
          if (userRole === 'employer_admin') {
            navigate('/employer', { replace: true });
          } else if (userRole === 'ops' || userRole === 'admin' || userRole === 'super_admin') {
            navigate('/ops', { replace: true });
          } else {
            navigate('/employee', { replace: true });
          }
        }
      }
    } catch (err) {
      const code = (err as AuthError).code ?? '';
      setError(t(mapAuthError(code)));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    try {
      await sendPasswordResetEmail(auth, email);
      setInfo(t('auth_reset_sent'));
    } catch (err) {
      const code = (err as AuthError).code ?? '';
      setError(t(mapAuthError(code)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="nav-logo">
          <Link to="/">
            <VidaLogo />
          </Link>
        </div>

        {mode === 'login' ? (
          <>
            <h2 className="auth-header">{t('auth_welcome')}</h2>
            <p className="auth-sub">{t('auth_signin_sub')}</p>

            {error && (
              <div className="auth-error show">{error}</div>
            )}
            {info && (
              <div
                className="auth-error show"
                style={{ borderLeftColor: 'var(--gold)', color: '#8d6e00' }}
              >
                {info}
              </div>
            )}

            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label>{t('auth_email')}</label>
                <input
                  className="auth-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth_email_placeholder')}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('auth_password')}</label>
                <input
                  className="auth-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth_password_placeholder')}
                  required
                />
              </div>

              <p style={{ textAlign: 'right', marginBottom: '16px' }}>
                <a
                  href="#"
                  className="auth-link"
                  onClick={(e) => {
                    e.preventDefault();
                    setMode('forgot');
                    setError('');
                    setInfo('');
                  }}
                >
                  {t('auth_forgot_password')}
                </a>
              </p>

              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? (
                  <>
                    <span className="spinner" /> {t('auth_signing_in')}
                  </>
                ) : (
                  t('auth_signin_btn')
                )}
              </button>
            </form>

            <p className="auth-footer">
              {t('auth_no_account')}{' '}
              <Link to="/onboarding">{t('auth_signup_link')}</Link>
            </p>
          </>
        ) : (
          <>
            <h2 className="auth-header">{t('auth_forgot_title')}</h2>
            <p className="auth-sub">{t('auth_forgot_sub')}</p>

            {error && (
              <div className="auth-error show">{error}</div>
            )}
            {info && (
              <div
                className="auth-error show"
                style={{ borderLeftColor: 'var(--success)', color: 'var(--success)' }}
              >
                {info}
              </div>
            )}

            <form onSubmit={handleForgotPassword}>
              <div className="form-group">
                <label>{t('auth_email')}</label>
                <input
                  className="auth-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth_email_placeholder')}
                  required
                />
              </div>

              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? t('auth_sending_reset') : t('auth_send_reset')}
              </button>
            </form>

            <p className="auth-footer">
              <a
                href="#"
                className="auth-link"
                onClick={(e) => {
                  e.preventDefault();
                  setMode('login');
                  setError('');
                  setInfo('');
                }}
              >
                {t('auth_back_to_login')}
              </a>
            </p>
          </>
        )}

        <p className="auth-footer" style={{ marginTop: '12px' }}>
          <a
            href="#"
            className="auth-link"
            onClick={(e) => {
              e.preventDefault();
              toggleLang();
            }}
          >
            {t('lang_toggle')}
          </a>
        </p>
      </div>
    </div>
  );
}
