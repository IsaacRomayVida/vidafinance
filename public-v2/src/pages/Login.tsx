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
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: '#faf9f7' }}>
      {/* ── Left branded panel ── */}
      <div className="login-v2-left" style={{
        width: '42%', minWidth: 360,
        background: 'linear-gradient(170deg, #0f2a2b 0%, #194445 55%, #1d5253 100%)',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        padding: '48px', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', width: 500, height: 500, top: -150, right: -150, borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,213,208,0.06), transparent 65%)', filter: 'blur(50px)', animation: 'onbMeshDrift 20s ease-in-out infinite', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', width: 300, height: 300, bottom: -100, left: -60, borderRadius: '50%', background: 'radial-gradient(circle, rgba(162,134,87,0.04), transparent 65%)', filter: 'blur(40px)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', zIndex: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 7, color: 'rgba(255,255,255,0.5)' }}>
            VID<span style={{ color: '#a28657' }}>A</span>
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 2 }}>
          <h2 style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 36, color: 'white', lineHeight: 1.12, letterSpacing: '-0.025em', marginBottom: 16 }}>
            Crédito que<br /><span style={{ fontStyle: 'italic', color: '#a8d5d0' }}>transforma</span> vidas.
          </h2>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.4)', lineHeight: 1.7, maxWidth: 320 }}>
            Microcréditos inteligentes con respaldo de nómina para los trabajadores de México.
          </p>
        </div>

        <div style={{ position: 'relative', zIndex: 2 }}>
          <div style={{ display: 'flex', gap: 32 }}>
            {[
              { val: '24h', label: 'Desembolso' },
              { val: '<2%', label: 'Mora' },
              { val: '$5K', label: 'Máximo' },
            ].map((s, i) => (
              <div key={i}>
                <div style={{ fontFamily: "'DM Serif Display'", fontSize: 22, color: 'rgba(255,255,255,0.7)' }}>{s.val}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 2, letterSpacing: 0.5 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '40px' }}>
      <div className="auth-card" style={{ boxShadow: 'none', border: 'none', maxWidth: 400, width: '100%' }}>
        <div className="nav-logo" style={{ display: 'none' }}>
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
                <label htmlFor="login-email">{t('auth_email')}</label>
                <input
                  id="login-email"
                  className="auth-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth_email_placeholder')}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="login-password">{t('auth_password')}</label>
                <input
                  id="login-password"
                  className="auth-input"
                  type="password"
                  autoComplete="current-password"
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
                <label htmlFor="forgot-email">{t('auth_email')}</label>
                <input
                  id="forgot-email"
                  className="auth-input"
                  type="email"
                  autoComplete="email"
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
    </div>
  );
}
