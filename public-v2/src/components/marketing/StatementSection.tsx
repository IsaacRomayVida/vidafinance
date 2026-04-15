import { useTranslation } from 'react-i18next';
import { RichText } from '../shared/RichText';

export function StatementSection() {
  const { t } = useTranslation();

  const emotions = [
    { key: '1', color: 'c1', icon: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M12 8v4M12 16h.01" /></>, stroke: '#dc503c' },
    { key: '2', color: 'c2', icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />, stroke: 'var(--brand-light)' },
    { key: '3', color: 'c3', icon: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></>, stroke: 'var(--brand)' },
    { key: '4', color: 'c4', icon: <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />, stroke: 'var(--gold)' },
  ];

  return (
    <section className="statement-section">
      <div className="statement-inner" style={{ alignItems: 'center' }}>
        <div className="statement-text rv">
          <h2><RichText html={t('stmt_h2')} /></h2>
          <p>{t('stmt_p')}</p>
          {/* Female worker photo */}
          <div style={{ marginTop: 40, position: 'relative', display: 'inline-block' }}>
            {/* Decorative gradient arc */}
            <div style={{
              position: 'absolute', bottom: -20, left: '50%', transform: 'translateX(-50%)',
              width: 320, height: 320, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(162,134,87,0.06) 0%, rgba(168,213,208,0.04) 40%, transparent 65%)',
              filter: 'blur(16px)', pointerEvents: 'none',
            }} />
            <img loading="lazy" src="/images/workerfemale.png" alt="Empleada usando VIDA"
              style={{
                width: 360, position: 'relative',
                filter: 'drop-shadow(0 16px 36px rgba(25,68,69,0.1))',
              }}
            />
          </div>
        </div>
        <div className="emo-col">
          {emotions.map((e, i) => (
            <div key={e.key} className={`emo-row rv d${i + 1}`}>
              <div className={`emo-icon ${e.color}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke={e.stroke} strokeWidth="1.5" opacity=".6">
                  {e.icon}
                </svg>
              </div>
              <div className="emo-info">
                <div className="emo-title">{t(`emo_${e.key}_title`)}</div>
                <div className="emo-desc">{t(`emo_${e.key}_desc`)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
