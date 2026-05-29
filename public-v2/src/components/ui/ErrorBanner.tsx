interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Accessible inline error banner with aria-live="polite".
 * Drop-in replacement for native alert() calls and for the
 * .auth-error pattern where you need a more structured element.
 */
export function ErrorBanner({ message, onDismiss, className, style }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 16px',
        borderRadius: 10,
        background: 'rgba(220,80,60,0.06)',
        border: '1px solid rgba(220,80,60,0.15)',
        fontSize: 13,
        color: 'var(--danger)',
        lineHeight: 1.5,
        ...style,
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            padding: 0,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
