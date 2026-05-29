import { Component, type ReactNode } from 'react';
import { captureError } from '../lib/sentry';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Funpay ErrorBoundary]', error, info.componentStack);
    captureError(error, { componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          minHeight: '60vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: 40,
          fontFamily: "'DM Sans', sans-serif",
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'var(--danger-bg)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', marginBottom: 20,
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)', marginBottom: 8, fontFamily: 'var(--df)' }}>
            Algo salió mal
          </h2>
          <p style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 24, textAlign: 'center', maxWidth: 360 }}>
            Ocurrió un error inesperado. Por favor recarga la página o intenta de nuevo.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', background: 'var(--brand)', color: '#fff',
              border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Recargar página
          </button>
          {process.env.NODE_ENV === 'development' && this.state.error && (
            <pre style={{ marginTop: 20, fontSize: 11, color: '#991b1b', maxWidth: 600, overflow: 'auto', background: 'var(--danger-bg)', padding: 16, borderRadius: 8 }}>
              {this.state.error.message}{'\n'}{this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
