import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { doc, getDoc, setDoc } from 'firebase/firestore';
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
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      const empRef = doc(db, 'employers', user.uid);
      const empDoc = await getDoc(empRef);

      if (empDoc.exists()) {
        const data = empDoc.data();
        if (data.employerCode) {
          setEmployerCode(data.employerCode);
        } else {
          // Generate code if missing
          const code = generateEmployerCode();
          await setDoc(empRef, { employerCode: code }, { merge: true });
          setEmployerCode(code);
        }
      }

      setLoading(false);
    })();
  }, [user]);

  const handleCopy = async () => {
    if (!employerCode) return;
    await navigator.clipboard.writeText(employerCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 28, color: "#0c1e1f", fontWeight: 400, letterSpacing: "-0.02em" }}>
        {t('dash_employees', 'Employees')}
      </h1>

      {/* Invite Code Card */}
      {!loading && employerCode && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-teal-900">
                {t('roster_invite_title')}
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                {t('roster_invite_desc')}
              </p>
            </div>
            <div className="mt-3 flex items-center gap-3 sm:mt-0">
              <span
                className="rounded-lg px-4 py-2 text-lg font-bold tracking-widest text-teal-900"
                style={{ background: 'rgba(36,122,110,0.08)', letterSpacing: '0.15em' }}
              >
                {employerCode}
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all"
                style={{
                  background: copied ? '#16a34a' : 'var(--brand, #247a6e)',
                  minWidth: 90,
                }}
              >
                {copied ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    {t('roster_copied')}
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    {t('roster_copy')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Employee List Placeholder */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm text-gray-500">
          {t('roster_empty', 'No employees enrolled yet.')}
        </p>
      </div>
    </div>
  );
}
