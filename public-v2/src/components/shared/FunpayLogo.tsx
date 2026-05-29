export function FunpayLogo({ variant = 'default' }: { variant?: 'default' | 'footer' }) {
  return (
    <span className={`funpay-logo ${variant === 'footer' ? 'ft' : ''}`} aria-label="Funpay">
      <span className="funpay-logo-text" aria-hidden="true">
        Funpay
      </span>
    </span>
  );
}
