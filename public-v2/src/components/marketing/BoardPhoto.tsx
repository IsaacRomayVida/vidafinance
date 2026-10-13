/**
 * A board's background: one photograph, optionally moving.
 *
 * Each photograph is used exactly once across the product
 * (docs/design/SHOT_LIST.md). A board with a `film` plays it while the board
 * is on screen — the film is generated from this exact still, which sits
 * under it as a lazy <img> — pauses when it leaves, and plays again from the
 * start when the reader comes back after it ended. It never loops behind the
 * reading.
 *
 * Boards sit below the fold, so nothing here is requested until the board is
 * within a screen or so of the viewport (useNearViewport): the film's source
 * is only set then, and it takes no `poster` — a poster is fetched eagerly,
 * which pulled these stills ahead of the hero image (Lighthouse LCP).
 *
 * The scrim lives here so type over any photograph has a floor it can rely
 * on.
 */
import { useEffect, useRef } from 'react';
import { publicAsset } from '../../lib/publicAsset';
import { useNearViewport } from '../../hooks/useNearViewport';

export function BoardPhoto({ still, film, position }: { still: string; film?: string; position?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [frame, near] = useNearViewport<HTMLDivElement>();
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const el = ref.current;
    if (!el || !film || reduced || !near) return;
    // Muted must be set before a source exists (facebook/react#10389).
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute('muted', '');
    el.playsInline = true;
    const src = publicAsset(film);
    if (el.getAttribute('src') !== src) {
      el.setAttribute('src', src);
      el.load();
    }
    const play = () => {
      const r = el.play?.();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    };
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (es) =>
              es.forEach((e) => {
                if (!e.isIntersecting) return el.pause();
                if (el.ended) el.currentTime = 0;
                play();
              }),
            { threshold: 0.25 }
          )
        : null;
    if (io) io.observe(el);
    else play();
    return () => io?.disconnect();
  }, [film, reduced, near]);

  const poster = publicAsset(still);
  return (
    <div ref={frame} className="mk-board-film" aria-hidden="true">
      <img src={near ? poster : undefined} alt="" loading="lazy" decoding="async" style={position ? { objectPosition: position } : undefined} />
      {film && !reduced && (
        <video ref={ref} muted playsInline preload="metadata" style={position ? { objectPosition: position } : undefined} />
      )}
      <span className="mk-board-scrim" />
    </div>
  );
}
