import { useTranslation } from 'react-i18next';

interface KYCBannerProps {
  kycStatus: string;
}

export function KYCBanner({ kycStatus }: KYCBannerProps) {
  const { t } = useTranslation();

  const isRejected = kycStatus === 'rejected';

  return (
    <div role="alert" className={`bo-alert${isRejected ? ' danger' : ''}`}>
      <b>
        {isRejected
          ? t('dash_kyc_rejected', 'Verificación rechazada')
          : kycStatus === 'not_started'
            ? t('dash_kyc_not_started', 'Verificación de identidad pendiente')
            : t('dash_kyc_pending', 'Verificación en proceso')}
      </b>
      {isRejected
        ? t('dash_kyc_rejected_desc', 'Tu verificación fue rechazada. Contacta soporte para más información.')
        : kycStatus === 'not_started'
          ? t('dash_kyc_not_started_desc', 'Completa tu verificación de identidad para acceder a tu crédito.')
          : t('dash_kyc_pending_desc', 'Estamos revisando tu documentación. Te notificaremos cuando esté lista.')}
    </div>
  );
}
