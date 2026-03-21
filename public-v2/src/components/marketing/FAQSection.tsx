import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const FAQ_COUNT = 6;

export function FAQSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);

  const toggle = (i: number) => setOpen(open === i ? null : i);

  return (
    <section className="section" id="faq">
      <div className="wrap">
        <div className="tag rv">{t('faq_tag')}</div>
        <h2 className="sh rv d1">{t('faq_h2')}</h2>
        <p className="sp rv d2">{t('faq_p')}</p>
        <div className="faq-list rv d3">
          {Array.from({ length: FAQ_COUNT }, (_, i) => i + 1).map((n) => (
            <div key={n} className={`faq-item${open === n ? ' open' : ''}`} onClick={() => toggle(n)}>
              <div className="faq-q">
                <span>{t(`faq_${n}_q`)}</span>
                <svg className="faq-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
              <div className="faq-a">{t(`faq_${n}_a`)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
