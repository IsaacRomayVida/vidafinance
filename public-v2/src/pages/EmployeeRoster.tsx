import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

function generateEmployerCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function EmployeeRoster() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [employerCode, setEmployerCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;

    (async () => {
      const empDoc = await getDoc(doc(db, 'employers', user.uid));
      if (!empDoc.exists()) {
        setLoading(false);
        return;
      }

      const data = empDoc.data();
      let code = data.employerCode as string | undefined;

      if (!code) {
        code = generateEmployerCode();
        await updateDoc(doc(db, 'employers', user.uid), { employerCode: code });
      }

      setEmployerCode(code);
      setLoading(false);
    })();
  }, [user]);

  async function handleCopy() {
    if (!employerCode) return;
    await navigator.clipboard.writeText(employerCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">
        {t('dash_employees', 'Employees')}
      </h1>

      {/* Invite code card */}
      {employerCode && (
        <div className="mt-6 rounded-xl border border-teal-200 bg-teal-50 p-6">
          <h2 className="text-lg font-semibold text-teal-900">
            {t('roster_invite_heading', 'Invite Employees')}
          </h2>
          <p className="mt-1 text-sm text-teal-700">
            {t('roster_invite_desc', 'Share this code with your employees so they can sign up and link to your company.')}
          </p>

          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-teal-600">
              {t('roster_invite_code_label', 'Employer Code')}
            </span>
            <span className="rounded-lg bg-white px-4 py-2 font-mono text-xl font-bold tracking-widest text-teal-900 shadow-sm"
              style={{ border: '1px solid rgba(25,68,69,0.12)' }}
            >
              {employerCode}
            </span>
            <button
              onClick={handleCopy}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all"
              style={{
                background: copied ? '#247a6e' : 'var(--brand)',
                minWidth: 80,
              }}
            >
              {copied ? t('roster_copied', 'Copied!') : t('roster_copy', 'Copy')}
            </button>
          </div>
        </div>
      )}

      {/* Empty employee list */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('roster_empty', 'No employees enrolled yet.')}
        </p>
      </div>
    </div>
  );
}
