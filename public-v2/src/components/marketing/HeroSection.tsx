import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement } from './Board';
import { ArrowIcon } from './ArrowIcon';
import { HeroFilm, type Film } from './HeroFilm';

/**
 * The site's one film (docs/design/SHOT_LIST.md, H1). It plays once and
 * holds on its last frame. Landscape fills the desktop stage; portrait is the
 * phone background. Placeholders until the composed 16:9 / 9:16 pair of the
 * same shot is generated: nothing here is used anywhere else on the site.
 */
const LANDSCAPE: Film[] = [
  { film: '/video/live-kitchen.mp4', still: '/images/brand/moment-kitchen.jpg' },
];
const PORTRAIT: Film[] = [
  { film: '/video/live-doorway.mp4', still: '/images/brand/home-doorway.jpg' },
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
