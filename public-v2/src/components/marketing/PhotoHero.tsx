import { useMemo, type ReactNode } from 'react';
import { Board } from './Board';
import { HeroFilm, type Film } from './HeroFilm';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/**
 * A page hero on a photograph (docs/design/SHOT_LIST.md): the statement over
 * one moment composed twice — `wide` (16:9) fills the desktop stage with the
 * headline over its calm left, `tall` (9:16) is the phone background with
 * its subject in the band below the text. Give an entry a `film` and it
 * plays on screen; without one the still stands alone.
 *
 * Only the composition for the current screen shape is mounted (same 860px
 * breakpoint as the CSS), so the hidden one never downloads.
 */
export function PhotoHero({
  label,
  id,
  wide,
  tall,
  children,
}: {
  label?: string;
  id?: string;
  wide: Film;
  tall: Film;
  children: ReactNode;
}) {
  const phone = useMediaQuery('(max-width: 860px)');
  // Stable reels: HeroFilm's effect depends on the array, and a new one per
  // render would restart a film that had finished. Define `wide` and `tall`
  // at module level so their identity is stable too.
  const wideReel = useMemo(() => [wide], [wide]);
  const tallReel = useMemo(() => [tall], [tall]);

  return (
    <Board label={label} id={id} className="mk-hero">
      <div className="mk-statement">
        {children}
        <div className="mk-stage" aria-hidden="true">
          {phone ? (
            <HeroFilm key="phone" reel={tallReel} className="mk-stage-film tall" />
          ) : (
            <HeroFilm key="desktop" reel={wideReel} className="mk-stage-film wide" />
          )}
        </div>
      </div>
    </Board>
  );
}
