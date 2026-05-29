import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const FAQ_COUNT = 6;

export function FAQSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();

  return (
    <section className="section" id="faq">
      <div className="wrap">
        <div className="tag rv">{t('faq_tag')}</div>
        <h2 className="sh rv d1">{t('faq_h2')}</h2>
        <p className="sp rv d2">{t('faq_p')}</p>
        <div className="faq-list rv d3">
          {Array.from({ length: FAQ_COUNT }, (_, i) => i + 1).map((n) => {
            const isOpen = open === n;
            const btnId = `${baseId}-faq-q-${n}`;
            const panelId = `${baseId}-faq-a-${n}`;
            return (
              <div key={n} className={`faq-item${isOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  id={btnId}
                  className="faq-q"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : n)}
                >
                  <span>{t(`faq_${n}_q`)}</span>
                  <svg
                    className="faq-chevron"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={btnId}
                  className="faq-a"
                >
                  <div className="faq-a-inner">
                    <p className="faq-a-text">{t(`faq_${n}_a`)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
