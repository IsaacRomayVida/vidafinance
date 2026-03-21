import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const items = [
  { key: '1', icon: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8M12 8v8" strokeLinecap="round" /></> },
  { key: '2', icon: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8M16 17H8M10 9H8" /></> },
  { key: '3', icon: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></> },
  { key: '4', icon: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></> },
];

export function TrustSection() {
  const { t } = useTranslation();

  return (
    <section className="section" id="trust">
      <div className="wrap">
        <div className="tag rv">{t('trust_tag')}</div>
        <h2 className="sh rv d1">{t('trust_h2')}</h2>
        <p className="sp rv d2" style={{ marginBottom: 56 }}>{t('trust_p')}</p>
        <div className="trust-grid rv d3">
          {items.map((item) => (
            <div key={item.key} className="trust-item">
              <div className="trust-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.5" opacity=".4">
                  {item.icon}
                </svg>
              </div>
              <div>
                <div className="trust-t">{t(`trust_${item.key}_title`)}</div>
                <div className="trust-d">{t(`trust_${item.key}_desc`)}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="trust-link rv d4">
          <Link to="/security">
            {t('trust_link')}{' '}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  );
}
