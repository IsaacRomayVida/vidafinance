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
      <section className="hero" style={{ padding: '100px 0 80px' }}>
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="wrap text-center">
          <span className="badge rv">{t('pg_contact_badge')}</span>
          <h1 className="rv d1"><RichText html={t('pg_contact_h1')} /></h1>
          <p className="sub rv d2">{t('pg_contact_sub')}</p>
        </div>
      </section>

      {/* Email Channels */}
      <section className="section tinted">
        <div className="wrap">
          <div className="trust-grid rv d2">
            {CHANNELS.map((ch) => (
              <div className="trust-item" key={ch}>
                <div>
                  <div className="trust-t">{t(`pg_contact_${ch}_t`)}</div>
                  <div className="trust-d">
                    <a href={`mailto:${t(`pg_contact_${ch}_v`)}`}>
                      {t(`pg_contact_${ch}_v`)}
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Offices */}
      <section className="section">
        <div className="wrap">
          <div className="tag rv">{t('pg_contact_office_tag')}</div>
          <div className="trust-grid rv d2">
            {['mx', 'ch'].map((loc) => (
              <div className="trust-item" key={loc}>
                <div>
                  <div className="trust-t">{t(`pg_contact_office_${loc}_t`)}</div>
                  <div className="trust-d">{t(`pg_contact_office_${loc}_d`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact Form */}
      <section className="section tinted">
        <div className="wrap">
          <ContactForm />
        </div>
      </section>
    </>
  );
}
