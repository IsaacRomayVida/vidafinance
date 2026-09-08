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
import { FunpayLogo } from '../components/shared/FunpayLogo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function mapAuthError(code: string): string {
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
      return 'auth_error_invalid_credentials';
    case 'auth/too-many-requests':
      return 'auth_error_too_many_requests';
    case 'auth/invalid-email':
      return 'auth_error_invalid_email';
    default:
      return 'auth_error_generic';
  }
}

/**
 * Login on a paper board: Doto ENTRAR label, 40px title, pill fields, one
 * green pill "Entrar", ghost link to create an account. No hero, no video.
 */
export function Login() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  useDocumentTitle(`FunPay — ${t('nav_login')}`);

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

      // Reload user to pick up server-side changes (e.g. autoVerifyTestAccounts)
      await cred.user.reload();

      // For test accounts, the Firestore auto-verify trigger may need a few seconds
      if (!cred.user.emailVerified && cred.user.email?.endsWith('@vida-test.com')) {
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 2000));
          await cred.user.reload();
          if (cred.user.emailVerified) break;
        }
      }

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
    <div className="mk-auth">
      <div className="mk-auth-board">
        <div className="mk-auth-head">
          <Link to="/" className="nav-logo"><FunpayLogo /></Link>
          <span className="dot">{mode === 'login' ? t('auth_label') : t('auth_forgot_label')}</span>
        </div>

        {mode === 'login' ? (
          <>
            <h1 className="mk-auth-title">{t('auth_welcome')}</h1>
            <p className="mk-auth-sub">{t('auth_signin_sub')}</p>

            {error && (
              <div className="mk-msg bad" role="alert">{error}</div>
            )}
            {info && (
              <div className="mk-msg ok" role="status">{info}</div>
            )}

            <form onSubmit={handleLogin}>
              <div className="mk-field">
                <label htmlFor="login-email">{t('auth_email')}</label>
                <input
                  id="login-email"
                  className="mk-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth_email_placeholder')}
                  required
                />
              </div>
              <div className="mk-field">
                <label htmlFor="login-password">{t('auth_password')}</label>
                <input
                  id="login-password"
                  className="mk-input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth_password_placeholder')}
                  required
                />
              </div>

              <div className="mk-auth-row">
                <button
                  type="button"
                  className="mk-link"
                  onClick={() => {
                    setMode('forgot');
                    setError('');
                    setInfo('');
                  }}
                >
                  {t('auth_forgot_password')}
                </button>
              </div>

              <button type="submit" className="mk-btn cta block" disabled={loading}>
                {loading ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> {t('auth_signing_in')}
                  </>
                ) : (
                  t('auth_signin_btn')
                )}
              </button>
            </form>

            <div className="mk-auth-foot">
              <span>{t('auth_no_account')}</span>
              <Link to="/onboarding" className="mk-btn ghost">{t('auth_signup_link')}</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="mk-auth-title">{t('auth_forgot_title')}</h1>
            <p className="mk-auth-sub">{t('auth_forgot_sub')}</p>

            {error && (
              <div className="mk-msg bad" role="alert">{error}</div>
            )}
            {info && (
              <div className="mk-msg ok" role="status">{info}</div>
            )}

            <form onSubmit={handleForgotPassword}>
              <div className="mk-field">
                <label htmlFor="forgot-email">{t('auth_email')}</label>
                <input
                  id="forgot-email"
                  className="mk-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth_email_placeholder')}
                  required
                />
              </div>

              <button type="submit" className="mk-btn cta block" disabled={loading}>
                {loading ? t('auth_sending_reset') : t('auth_send_reset')}
              </button>
            </form>

            <div className="mk-auth-foot">
              <button
                type="button"
                className="mk-link"
                onClick={() => {
                  setMode('login');
                  setError('');
                  setInfo('');
                }}
              >
                {t('auth_back_to_login')}
              </button>
            </div>
          </>
        )}

        <div className="mk-auth-lang">
          <button type="button" className="mk-icon-btn" aria-label={t('a11y_lang_toggle')} onClick={toggleLang}>
            {t('lang_toggle')}
          </button>
        </div>
      </div>
    </div>
  );
}
