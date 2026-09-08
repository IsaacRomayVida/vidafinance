import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement, ArrowIcon } from './Board';
import { HeroFilm, type Film } from './HeroFilm';

/**
 * The reels. Landscape films fill the desktop stage; the portrait cuts are
 * the phone background, where the film is the board itself. Each entry is a
 * photograph from the site and the film generated from it.
 */
const LANDSCAPE: Film[] = [
  { film: '/video/live-kitchen.mp4', still: '/images/brand/moment-kitchen.jpg' },
  { film: '/video/live-pharmacy.mp4', still: '/images/brand/moment-pharmacy.jpg' },
  { film: '/video/live-backpack.mp4', still: '/images/brand/moment-backpack.jpg' },
];
const PORTRAIT: Film[] = [
  { film: '/video/live-doorway.mp4', still: '/images/brand/home-doorway.jpg' },
  { film: '/video/live-stall.mp4', still: '/images/brand/home-stall.jpg' },
];

/**
 * Statement board — the landing hero from funpay-ui. The films rotate: each
 * plays once and crossfades into the next, landscape in the desktop stage and
 * portrait as the phone background. One big Urbanist
 * headline alternating ink and quiet lines, and two
 * floating elements over the stage: the capture bar (dark pill, icon
 * circles, active one cream) at −3° and the identity card (employee ·
 * payroll · lender) at +5°, over the ambient film. Below 860px the film
 * becomes the board's own background and the statement sits on it.
 */
export function HeroSection() {
  const { t } = useTranslation();

  return (
    <Board label={t('hero_badge')} id="top" className="mk-hero">
      <div className="mk-statement">
        <Statement html={t('hero_h1')}>
          <div className="mk-actions">
            <Link to="/#how" className="mk-btn">{t('hero_cta_employee')} {ArrowIcon}</Link>
            <Link to="/employers" className="mk-btn ghost">{t('hero_cta_employer')}</Link>
          </div>
          <p className="mk-disclose">{t('hero_sub')}</p>
        </Statement>

        <div className="mk-stage" aria-hidden="true">
          {/* The freedom motif: the cream-and-sage kite drifting in a pale sky.
              A real <video> so it actually moves; the still stands in under
              reduced motion or while it loads. */}
          <HeroFilm reel={LANDSCAPE} className="mk-stage-film wide" />
          <HeroFilm reel={PORTRAIT} className="mk-stage-film tall" />
        </div>
      </div>
    </Board>
  );
}
