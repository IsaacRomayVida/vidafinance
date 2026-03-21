import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../shared/RichText';

export function ClosingSection() {
  const { t } = useTranslation();

  return (
    <section className="closing">
      <div className="closing-glow" />
      <h2 className="rv"><RichText html={t('close_h2')} /></h2>
      <p className="closing-sub rv d1">{t('close_sub')}</p>
      <Link to="/onboarding" className="closing-btn rv d2">{t('close_cta')}</Link>
    </section>
  );
}
