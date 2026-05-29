import { useTranslation } from 'react-i18next';
import { RevealOnScroll } from '../ui/RevealOnScroll';

const scenarios = [
  { key: '1', cls: 'r', stroke: 'var(--danger)', icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />, amount: '$3,500' },
  { key: '2', cls: 'a', stroke: 'var(--gold)', icon: <><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>, amount: '$4,200' },
  { key: '3', cls: 'b', stroke: 'var(--brand)', icon: <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>, amount: '$2,800' },
  { key: '4', cls: 'g', stroke: 'var(--brand-light)', icon: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></>, amount: '$5,000' },
];

export function FeatureCards() {
  const { t } = useTranslation();

  return (
    <section className="section tinted" id="employees">
      <div className="wrap">
        <div className="scenario-header">
          <RevealOnScroll><div className="tag">{t('scn_tag')}</div></RevealOnScroll>
          <RevealOnScroll delay={0.1}><h2 className="sh">{t('scn_h2')}</h2></RevealOnScroll>
          <RevealOnScroll delay={0.2}><p className="sp">{t('scn_p')}</p></RevealOnScroll>
        </div>
        <RevealOnScroll delay={0.3}>
          <div className="scenario-grid">
            {scenarios.map((s) => (
              <div key={s.key} className="scenario">
                <div className={`scenario-icon ${s.cls}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke={s.stroke} strokeWidth="1.5" opacity=".6">
                    {s.icon}
                  </svg>
                </div>
                <div className="scenario-t">{t(`scn_${s.key}_title`)}</div>
                <div className="scenario-d">{t(`scn_${s.key}_desc`)}</div>
                <div className="scenario-amt">{s.amount}</div>
              </div>
            ))}
          </div>
        </RevealOnScroll>
      </div>
    </section>
  );
}
