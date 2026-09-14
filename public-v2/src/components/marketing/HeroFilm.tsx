/**
 * The hero's rotating film.
 *
 * Every film is one of the published photographs, moving — generated with
 * image-to-video from that exact still, so the first frame IS the picture on
 * the page. The reel cycles through them: each plays once, then crossfades
 * into the next, so the hero shows the whole story rather than one moment.
 *
 * Two stacked <video> layers do the crossfade: the visible one plays while
 * the hidden one preloads the next film, then they swap. Under reduced
 * motion nothing plays and the still stands alone.
 */
import { useEffect, useRef, useState } from 'react';
import { publicAsset } from '../../lib/publicAsset';

export interface Film {
  film: string;
  still: string;
}

/**
 * Muted must be set BEFORE a source exists: React does not apply the `muted`
 * attribute during render (facebook/react#10389), so a `<video autoPlay muted>`
 * is evaluated as unmuted, refused by autoplay policy, and left frozen.
 */
function arm(el: HTMLVideoElement, film: string) {
  const src = publicAsset(film);
  el.muted = true;
  el.defaultMuted = true;
  el.setAttribute('muted', '');
  el.playsInline = true;
  if (el.getAttribute('src') !== src) {
    el.setAttribute('src', src);
    el.load();
  }
}

/** play() does not always return a promise (jsdom returns undefined). */
function safePlay(el: HTMLVideoElement) {
  const r = el.play?.();
  if (r && typeof r.catch === 'function') r.catch(() => {});
}

export function HeroFilm({ reel, className }: { reel: Film[]; className?: string }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [front, setFront] = useState<'a' | 'b'>('a');

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (reduced || reel.length === 0) return;
    const single = reel.length < 2;
    const showing = front === 'a' ? a.current : b.current;
    const waiting = single ? null : front === 'a' ? b.current : a.current;
    if (!showing || (!single && !waiting)) return;

    arm(showing, reel[index % reel.length].film);
    // Stage the next film behind the visible one so the swap has no gap.
    if (waiting) arm(waiting, reel[(index + 1) % reel.length].film);

    // Play only while on screen. Both reels are always mounted and one is
    // display:none (the landscape stage vs the portrait background), so
    // playing on mount ran the hidden film to its end — switching viewport
    // then revealed a frozen last frame. A film that has ended stays ended:
    // it holds, it does not restart.
    const onScreen = (visible: boolean) => {
      if (!visible) showing.pause();
      else if (!showing.ended) safePlay(showing);
    };
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((es) => es.forEach((e) => onScreen(e.isIntersecting)), { threshold: 0.1 })
        : null;
    if (io) io.observe(showing);
    else safePlay(showing);

    const advance = () => {
      // A single film plays once and holds its last frame: the scene
      // arrives and settles, rather than looping like a GIF behind the type.
      if (!waiting) return;
      waiting.currentTime = 0;
      safePlay(waiting);
      setFront((f) => (f === 'a' ? 'b' : 'a'));
      setIndex((i) => (i + 1) % reel.length);
    };
    showing.addEventListener('ended', advance);
    return () => {
      showing.removeEventListener('ended', advance);
      io?.disconnect();
    };
  }, [index, front, reel, reduced]);

  const still = reel[index % reel.length]?.still;
  const poster = still ? publicAsset(still) : undefined;
  if (reduced) return <img className={className} src={poster} alt="" />;

  // No autoPlay attribute: it would start the hidden reel on load. Playback
  // is driven by the effect above; muted is applied there before any source.
  return (
    <>
      <video
        ref={a}
        className={`${className ?? ''} mk-film-layer${front === 'a' ? ' on' : ''}`}
        muted
        playsInline
        preload="auto"
        poster={poster}
      />
      {reel.length > 1 && (
        <video
          ref={b}
          className={`${className ?? ''} mk-film-layer${front === 'b' ? ' on' : ''}`}
          muted
          playsInline
          preload="auto"
        />
      )}
    </>
  );
}
