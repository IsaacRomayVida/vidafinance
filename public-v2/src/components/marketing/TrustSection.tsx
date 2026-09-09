import { useTranslation } from 'react-i18next';
import { BoardFilm } from './BoardFilm';
import { Link } from 'react-router-dom';
import { Board, BoardHead, ArrowIcon } from './Board';

const icons = [
  <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></>,
  <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>,
  <><rect x="3" y="11" width="18" height="11" rx="3" /><path d="M7 11V7a5 5 0 0110 0v4" /></>,
  <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M3 10h18" /></>,
];

/**
 * Trust on the painted "leaf" board — the CSS stand-in for the macro
 * botanical photograph. White title, frosted rows.
 */
export function TrustSection() {
  const { t } = useTranslation();

  return (
    <Board className="film" id="trust">
      <BoardFilm film="/video/live-backpack.mp4" still="/images/brand/moment-backpack.jpg" />
      <div className="mk-cols">
        <div className="sticky sh">
          <BoardHead kicker={t('trust_tag')} title={t('trust_h2')} lead={t('trust_p')} />
          <div className="mk-actions">
            <Link to="/security" className="mk-btn white">{t('trust_link')} {ArrowIcon}</Link>
          </div>
        </div>
        <ul className="mk-rows">
          {[1, 2, 3, 4].map((n, i) => (
            <li key={n} className="mk-row">
              <span className="a" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icons[i]}</svg>
              </span>
              <div className="t">
                <b>{t(`trust_${n}_title`)}</b>
                <span>{t(`trust_${n}_desc`)}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Board>
  );
}
