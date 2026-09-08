import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement } from './Board';

/** Closing statement: one line, one ink pill, one ghost. No testimonials, no faces. */
export function ClosingSection() {
  const { t } = useTranslation();

  return (
    <Board tone="sage" id="closing" className="mk-closing">
      <img className="mk-closing-art" src="/images/brand/cutout-hands-kite.png" alt="" loading="lazy" />
      <Statement html={t('close_h2')} lead={t('close_sub')} center>
        <div className="mk-actions">
          <Link to="/onboarding" className="mk-btn">{t('close_cta')}</Link>
          <Link to="/employers" className="mk-btn ghost">{t('hero_cta_employer')}</Link>
        </div>
      </Statement>
    </Board>
  );
}
