import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function TermsPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_terms_badge')}`);

  return (
    <>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 40px' }}>
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_terms_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_terms_h1')} /></h1>
            <p style={{ fontSize: 13, color: 'var(--t3)', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_terms_updated')}</p>
          </div>
        </div>
      </section>

      {/* Content */}
      <section className="section">
        <div className="wrap" style={{ maxWidth: 760 }}>
          <p className="rv" style={{ fontSize: 16, color: 'var(--t2)', lineHeight: 1.8, marginBottom: 48, paddingBottom: 36, borderBottom: '1px solid rgba(25,68,69,0.04)' }}>{t('pg_terms_intro')}</p>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className={`rv d${i}`} style={{ padding: '36px 0', borderBottom: '1px solid rgba(25,68,69,0.04)' }}>
              <h3 style={{ fontFamily: 'var(--df)', fontSize: 22, color: 'var(--t1)', marginBottom: 12, letterSpacing: '-.02em' }}>{t(`pg_terms_${i}_t`)}</h3>
              <p style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.8 }}>{t(`pg_terms_${i}_p`)}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
