import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Statement } from './Board';
import { ArrowIcon } from './ArrowIcon';
import { PhotoHero } from './PhotoHero';
import type { Film } from './HeroFilm';

/**
 * The home hero (docs/design/SHOT_LIST.md, H1): "the shift ends", one moment
 * composed twice — 16:9 fills the desktop stage, 9:16 is the phone
 * background. Each film starts from its still (also its poster) and plays
 * while on screen.
 */
const WIDE: Film = { film: '/video/hero-dawn-16x9.mp4', still: '/images/brand/hero-dawn-16x9.jpg' };
const TALL: Film = { film: '/video/hero-dawn-9x16.mp4', still: '/images/brand/hero-dawn-9x16.jpg' };

/** Statement board — the landing hero from funpay-ui, on its film. */
export function HeroSection() {
  const { t } = useTranslation();

  return (
    <PhotoHero label={t('hero_badge')} id="top" wide={WIDE} tall={TALL}>
      <Statement html={t('hero_h1')}>
        <div className="mk-actions">
          <Link to="/#how" className="mk-btn">{t('hero_cta_employee')} {ArrowIcon}</Link>
          <Link to="/employers" className="mk-btn ghost">{t('hero_cta_employer')}</Link>
        </div>
        <p className="mk-disclose">{t('hero_sub')}</p>
      </Statement>
    </PhotoHero>
  );
}
