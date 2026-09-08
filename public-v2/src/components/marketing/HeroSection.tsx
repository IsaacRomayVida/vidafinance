import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, Statement, ArrowIcon } from './Board';

/** Ambient: morning light and palm shadows moving down a hotel corridor.
 *  Empty on purpose — a background has to carry type. */
const HERO_FILM = '/video/ambient-loop-wide.mp4';

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
          <img className="mk-stage-still" src="/images/brand/home-doorway.jpg" alt="" />
          <video
            className="mk-stage-film"
            ref={(el) => {
              // muted BEFORE a source exists, or the browser evaluates the
              // element as unmuted, refuses autoplay and freezes frame 1.
              if (!el) return;
              el.muted = true;
              el.defaultMuted = true;
              el.setAttribute('muted', '');
              el.playsInline = true;
              if (el.getAttribute('src') !== HERO_FILM) {
                el.setAttribute('src', HERO_FILM);
                el.load();
                el.play().catch(() => {});
              }
            }}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster="/images/brand/home-doorway.jpg"
          />
          <div className="mk-float mk-capture" style={{ left: '4%', top: '16%', transform: 'rotate(-3deg)' }}>
            <div className="ic on">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z" /></svg>
            </div>
            <div className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </div>
            <div className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M3 10h18" /></svg>
            </div>
            <div className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20l4-1 11-11-3-3L5 16z" /></svg>
            </div>
          </div>

          <div className="mk-float mk-ticket" style={{ left: '10%', bottom: '6%', transform: 'rotate(2deg)' }}>
            <div className="lbl">{t('hero_ticket_label')}</div>
            <div className="big">3,000<small>MXN</small></div>
            <div className="line"><b>{t('hero_ticket_total')}</b> · {t('hero_ticket_cat')}</div>
          </div>

          <div className="mk-float mk-ident" style={{ right: '2%', top: '30%', transform: 'rotate(5deg)' }}>
            <div className="row"><span className="a">TÚ</span>{t('ident_you')}<span>{t('ident_row_employee')}</span></div>
            <div className="row"><span className="a">TE</span>{t('ident_your_company')}<span>{t('ident_row_payroll')}</span></div>
            <div className="row"><span className="a">AC</span>Aliados<span>{t('ident_row_lender')}</span></div>
          </div>
        </div>
      </div>
    </Board>
  );
}
