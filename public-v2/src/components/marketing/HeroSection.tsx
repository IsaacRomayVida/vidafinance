import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement } from './Board';
import { ArrowIcon } from './ArrowIcon';
import { HeroFilm, type Film } from './HeroFilm';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/**
 * The site's one film (docs/design/SHOT_LIST.md, H1): "the shift ends", one
 * moment composed twice — 16:9 fills the desktop stage, 9:16 is the phone
 * background. Each film starts from its still (also its poster), plays once
 * while on screen, and holds on its last frame.
 */
const LANDSCAPE: Film[] = [
  { film: '/video/hero-dawn-16x9.mp4', still: '/images/brand/hero-dawn-16x9.jpg' },
];
const PORTRAIT: Film[] = [
  { film: '/video/hero-dawn-9x16.mp4', still: '/images/brand/hero-dawn-9x16.jpg' },
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
  // Mount only the film for this screen shape (same breakpoint as the CSS).
  // With both mounted, the hidden one still downloaded, and its playback
  // hung on script alone.
  const phone = useMediaQuery('(max-width: 860px)');

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
          {/* The site's one film. A real <video> so it actually moves; the
              still stands in under reduced motion or while it loads. */}
          {phone ? (
            <HeroFilm key="phone" reel={PORTRAIT} className="mk-stage-film tall" />
          ) : (
            <HeroFilm key="desktop" reel={LANDSCAPE} className="mk-stage-film wide" />
          )}
        </div>
      </div>
    </Board>
  );
}
