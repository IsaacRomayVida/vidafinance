import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function SecurityPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_sec_badge')}`);

  return (
    <>

      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_sec_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_sec_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_sec_sub')}</p>
          </div>
        </div>
      </section>

      {/* Encryption — 2x2 grid with borders */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_enc_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_sec_enc_h')} /></h2>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, marginTop: 56, borderTop: '1px solid rgba(25,68,69,0.04)' }}>
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`rv d${n + 1}`}
                style={{
                  padding: n % 2 === 1 ? '40px 40px 40px 0' : '40px 0 40px 40px',
                  borderBottom: n <= 2 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                  borderRight: n % 2 === 1 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{t(`pg_sec_enc_${n}_t`)}</div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.6 }}>{t(`pg_sec_enc_${n}_d`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Infrastructure — 2-col lp-grid with sticky left */}
      <section className="section tinted">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_infra_tag')}</div>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div className="rv d1" style={{ position: 'sticky', top: 120 }}>
              <h2 className="sh"><RichText html={t('pg_sec_infra_h')} /></h2>
              <p className="sp" style={{ marginTop: 16 }}>{t('pg_sec_infra_p')}</p>
            </div>
            <div className="rv d2">
              <div className="metrics" style={{ margin: 0 }}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <div key={n} className="metric">
                    <div className="metric-v">{t(`pg_sec_infra_${n}_v`)}</div>
                    <div className="metric-l">{t(`pg_sec_infra_${n}_l`)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Practices — 2x2 grid with borders */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_sec_practices_tag')}</div>
          <h2 className="sh rv d1"><RichText html={t('pg_sec_practices_h')} /></h2>
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, marginTop: 56, borderTop: '1px solid rgba(25,68,69,0.04)' }}>
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`rv d${n + 1}`}
                style={{
                  padding: n % 2 === 1 ? '40px 40px 40px 0' : '40px 0 40px 40px',
                  borderBottom: n <= 2 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                  borderRight: n % 2 === 1 ? '1px solid rgba(25,68,69,0.04)' : undefined,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{t(`pg_sec_pr_${n}_t`)}</div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.6 }}>{t(`pg_sec_pr_${n}_d`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
