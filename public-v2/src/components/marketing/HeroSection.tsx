import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement, ArrowIcon } from './Board';

/**
 * The hero films are the published photographs, moving — generated with
 * image-to-video from those exact stills, so the first frame IS the picture.
 * Portrait on phones (where the film is the board's background) and
 * landscape on desktop, each with its own still as the poster.
 */
const HERO = {
  portrait: { film: '/video/live-doorway.mp4', still: '/images/brand/home-doorway.jpg' },
  landscape: { film: '/video/live-kitchen.mp4', still: '/images/brand/moment-kitchen.jpg' },
};

/** Muted must be set before a source exists or the browser refuses autoplay
 *  and freezes the first frame (React does not apply `muted` during render). */
function armVideo(el: HTMLVideoElement | null, src: string) {
  if (!el) return;
  el.muted = true;
  el.defaultMuted = true;
  el.setAttribute('muted', '');
  el.playsInline = true;
  if (el.getAttribute('src') !== src) {
    el.setAttribute('src', src);
    el.load();
    el.play().catch(() => {});
  }
}

/**
 * Statement board — the landing hero from funpay-ui. One big Urbanist
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
          <img className="mk-stage-still" src={HERO.landscape.still} alt="" />
          <video
            className="mk-stage-film wide"
            ref={(el) => armVideo(el, HERO.landscape.film)}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster={HERO.landscape.still}
          />
          <video
            className="mk-stage-film tall"
            ref={(el) => armVideo(el, HERO.portrait.film)}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster={HERO.portrait.still}
          />
        </div>
      </div>
    </Board>
  );
}
