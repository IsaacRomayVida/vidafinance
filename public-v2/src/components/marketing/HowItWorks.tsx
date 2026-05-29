import { useTranslation } from 'react-i18next';
import { RevealOnScroll } from '../ui/RevealOnScroll';

export function HowItWorks() {
  const { t } = useTranslation();

  return (
    <section className="section" id="how">
      <div className="wrap">
        <div className="hiw-grid">
          <div className="hiw-text">
            <RevealOnScroll><div className="tag">{t('hiw_tag')}</div></RevealOnScroll>
            <RevealOnScroll delay={0.1}><h2 className="sh">{t('hiw_h2')}</h2></RevealOnScroll>
            <RevealOnScroll delay={0.2}><p className="sp">{t('hiw_p')}</p></RevealOnScroll>
          </div>
          <div className="steps">
            {[1, 2, 3, 4].map((n) => (
              <RevealOnScroll key={n} delay={n * 0.1}>
                <div className="step">
                  <div className="step-n">{n}</div>
                  <div>
                    <div className="step-title">{t(`step_${n}_title`)}</div>
                    <div className="step-desc">{t(`step_${n}_desc`)}</div>
                  </div>
                </div>
              </RevealOnScroll>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
