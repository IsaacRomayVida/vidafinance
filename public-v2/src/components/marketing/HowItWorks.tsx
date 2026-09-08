import { useTranslation } from 'react-i18next';
import { BoardFilm } from './BoardFilm';
import { Board, BoardHead, PillSteps } from './Board';

export function HowItWorks() {
  const { t } = useTranslation();

  return (
    <Board tone="leaf" className="film" id="how">
      <BoardFilm film="/video/live-stall.mp4" still="/images/brand/home-stall.jpg" />
      <div className="mk-cols">
        <div className="sticky">
          <BoardHead kicker={t('hiw_tag')} title={t('hiw_h2')} lead={t('hiw_p')} />
        </div>
        <PillSteps
          items={[1, 2, 3].map((n) => ({
            title: t(`step_${n}_title`),
            sub: t(`step_${n}_desc`),
            value: t(`step_${n}_val`),
          }))}
        />
      </div>
    </Board>
  );
}
