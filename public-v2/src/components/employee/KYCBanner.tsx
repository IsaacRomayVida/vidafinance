import { useTranslation } from 'react-i18next';

interface KYCBannerProps {
  kycStatus: string;
}

export function KYCBanner({ kycStatus }: KYCBannerProps) {
  const { t } = useTranslation();

  const isRejected = kycStatus === 'rejected';

  return (
    <div style={{ margin: '0 auto', maxWidth: 960, padding: '0 20px' }}>
      <div
        role="alert"
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px', borderRadius: 12,
          background: isRejected ? 'rgba(220,80,60,0.05)' : 'rgba(162,134,87,0.06)',
          border: `1px solid ${isRejected ? 'rgba(220,80,60,0.18)' : 'rgba(162,134,87,0.2)'}`,
          marginBottom: 16,
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isRejected ? 'rgba(220,80,60,0.08)' : 'rgba(162,134,87,0.1)',
          flexShrink: 0,
        }}>
          {isRejected ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: isRejected ? 'var(--danger)' : 'var(--gold)' }}>
            {isRejected
              ? t('dash_kyc_rejected', 'Verificación rechazada')
              : kycStatus === 'not_started'
                ? t('dash_kyc_not_started', 'Verificación de identidad pendiente')
                : t('dash_kyc_pending', 'Verificación en proceso')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 2 }}>
            {isRejected
              ? t('dash_kyc_rejected_desc', 'Tu verificación fue rechazada. Contacta soporte para más información.')
              : kycStatus === 'not_started'
                ? t('dash_kyc_not_started_desc', 'Completa tu verificación de identidad para acceder a tu crédito.')
                : t('dash_kyc_pending_desc', 'Estamos revisando tu documentación. Te notificaremos cuando esté lista.')}
          </div>
        </div>
      </div>
    </div>
  );
}
