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
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '48px 24px 64px' }}>
      {/* Page title */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{
          fontFamily: "'DM Serif Display',Georgia,serif",
          fontSize: 26,
          color: '#0c1e1f',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          marginBottom: 16,
        }}>
          {t('dash_employees', 'Empleados')}
        </h1>
        <p style={{ fontSize: 14, color: '#4a6364', lineHeight: 1.7 }}>
          {t('roster_invite_desc', 'Comparte el código de invitación con tus empleados para que puedan registrarse.')}
        </p>
      </div>

      {/* Invite Code Card */}
      {!loading && employerCode && (
        <div style={{
          background: '#fff',
          borderRadius: 20,
          padding: '36px 28px',
          border: '1px solid rgba(25,68,69,0.04)',
          boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
          marginBottom: 20,
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 10.5,
            fontWeight: 700,
            textTransform: 'uppercase' as const,
            letterSpacing: '2.2px',
            color: '#a28657',
            marginBottom: 20,
          }}>
            {t('roster_invite_title', 'Código de Invitación')}
          </div>

          {/* Code display */}
          <div style={{
            fontFamily: "'DM Serif Display',Georgia,serif",
            fontSize: 40,
            color: '#0c1e1f',
            letterSpacing: '0.2em',
            fontWeight: 400,
            marginBottom: 28,
            lineHeight: 1,
          }}>
            {employerCode}
          </div>

          {/* Copy button */}
          <button
            onClick={handleCopy}
            style={{
              width: '100%',
              background: copied ? '#247a6e' : '#194445',
              color: '#fff',
              borderRadius: 60,
              padding: '14px 24px',
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              letterSpacing: '0.2px',
              cursor: 'pointer',
              transition: 'all 0.3s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16 }}>
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                {t('roster_copied', 'Copiado')}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}>
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                {t('roster_copy', 'Copiar Código')}
              </>
            )}
          </button>
        </div>
      )}

      {/* Employee List */}
      <div style={{
        background: '#fff',
        borderRadius: 20,
        padding: '36px 28px',
        border: '1px solid rgba(25,68,69,0.04)',
        boxShadow: '0 1px 4px rgba(25,68,69,0.02)',
        textAlign: 'center',
      }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'rgba(162,134,87,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px',
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#a28657" strokeWidth="1.5" style={{ width: 24, height: 24 }}>
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
        </div>
        <p style={{
          fontSize: 14,
          color: '#93aaa9',
          lineHeight: 1.6,
          maxWidth: 280,
          margin: '0 auto',
        }}>
          {t('roster_empty', 'Aún no hay empleados registrados. Comparte tu código de invitación para comenzar.')}
        </p>
      </div>
    </div>
  );
}
