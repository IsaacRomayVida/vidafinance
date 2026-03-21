import { useTranslation } from 'react-i18next';

export function HowItWorks() {
  const { t } = useTranslation();

  return (
    <section className="section" id="how">
      <div className="wrap">
        <div className="hiw-grid">
          <div className="hiw-text">
            <div className="tag rv">{t('hiw_tag')}</div>
            <h2 className="sh rv d1">{t('hiw_h2')}</h2>
            <p className="sp rv d2">{t('hiw_p')}</p>
          </div>
          <div className="steps">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className={`step rv d${n + 1}`}>
                <div className="step-n">{n}</div>
                <div>
                  <div className="step-title">{t(`step_${n}_title`)}</div>
                  <div className="step-desc">{t(`step_${n}_desc`)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
