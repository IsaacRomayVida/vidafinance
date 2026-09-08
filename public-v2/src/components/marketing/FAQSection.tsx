import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Board, BoardHead } from './Board';

const FAQ_COUNT = 6;

/** FAQ as pills that open: the open one goes white and floats. */
export function FAQSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const baseId = useId();

  return (
    <Board tone="paper" id="faq">
      <div className="mk-cols">
        <div className="sticky">
          <BoardHead kicker={t('faq_tag')} title={t('faq_h2')} lead={t('faq_p')} />
        </div>
        <ul className="mk-faq">
          {Array.from({ length: FAQ_COUNT }, (_, i) => i + 1).map((n) => {
            const isOpen = open === n;
            const btnId = `${baseId}-faq-q-${n}`;
            const panelId = `${baseId}-faq-a-${n}`;
            return (
              <li key={n} className={`mk-faq-item${isOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  id={btnId}
                  className="mk-faq-q"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpen(isOpen ? null : n)}
                >
                  <span>{t(`faq_${n}_q`)}</span>
                  <span className="chev" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                </button>
                <div id={panelId} role="region" aria-labelledby={btnId} className="mk-faq-a">
                  <div className="mk-faq-a-inner">
                    <p>{t(`faq_${n}_a`)}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Board>
  );
}
