import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../lib/firebase';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-teal-950 px-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-teal-900">{t('auth_welcome')}</h1>
        <p className="mt-1 text-sm text-teal-600">{t('auth_signin_sub')}</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-teal-800">
              {t('auth_email')}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth_email_placeholder')}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-teal-800">
              {t('auth_password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth_password_placeholder')}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              required
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-teal-900 py-2.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
          >
            {loading ? t('auth_signing_in') : t('auth_signin_btn')}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-600">
          {t('auth_no_account')}{' '}
          <Link to="/get-started" className="font-medium text-teal-700 hover:text-teal-900">
            {t('auth_signup_link')}
          </Link>
        </p>
      </div>
    </div>
  );
}
