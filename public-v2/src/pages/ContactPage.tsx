import { useTranslation } from 'react-i18next';
import { RichText } from '../components/shared/RichText';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ContactForm } from '../components/marketing/ContactForm';

const CHANNELS = ['general', 'employers', 'press', 'investors', 'privacy'] as const;

export function ContactPage() {
  const { t } = useTranslation();
  useRevealOnScroll();
  useDocumentTitle(`VIDA — ${t('pg_contact_badge')}`);

  return (
    <>

      {/* Hero */}
      <section className="hero" style={{ padding: '100px 0 60px' }}>
        <div className="hero-blob b1" />
        <div className="hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div className="hero-text" style={{ textAlign: 'center' }}>
            <div className="hero-badge" style={{ justifyContent: 'center' }}>
              <span className="badge-dot" /><span className="badge-text">{t('pg_contact_badge')}</span>
            </div>
            <h1 style={{ opacity: 0, animation: 'fu .9s ease .3s forwards' }}><RichText html={t('pg_contact_h1')} /></h1>
            <p className="hero-sub" style={{ maxWidth: 520, margin: '0 auto', opacity: 0, animation: 'fu .9s ease .45s forwards' }}>{t('pg_contact_sub')}</p>
          </div>
        </div>
      </section>

      {/* 2-col: emails+offices left, form right */}
      <section className="section">
        <div className="wrap">
          <div className="lp-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, alignItems: 'start' }}>
            <div>
              <div className="rv" style={{ marginBottom: 48 }}>
                {CHANNELS.map((ch) => (
                  <div key={ch} style={{ padding: '20px 0', borderBottom: '1px solid rgba(25,68,69,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: 'var(--t3)' }}>{t(`pg_contact_${ch}_t`)}</span>
                    <a href={`mailto:${t(`pg_contact_${ch}_v`)}`} style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', borderBottom: '1px solid rgba(25,68,69,0.12)', paddingBottom: 1 }}>
                      {t(`pg_contact_${ch}_v`)}
                    </a>
                  </div>
                ))}
              </div>
              <div className="tag rv d1">{t('pg_contact_office_tag')}</div>
              <div className="rv d2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 36, marginTop: 24 }}>
                {['mx', 'ch'].map((loc) => (
                  <div key={loc}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{t(`pg_contact_office_${loc}_t`)}</div>
                    <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: t(`pg_contact_office_${loc}_d`) }} />
                  </div>
                ))}
              </div>
            </div>
            <div className="rv d2">
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
