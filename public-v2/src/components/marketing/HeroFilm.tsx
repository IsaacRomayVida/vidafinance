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

export interface Film {
  film: string;
  still: string;
}

/**
 * Muted must be set BEFORE a source exists: React does not apply the `muted`
 * attribute during render (facebook/react#10389), so a `<video autoPlay muted>`
 * is evaluated as unmuted, refused by autoplay policy, and left frozen.
 */
function arm(el: HTMLVideoElement, src: string) {
  el.muted = true;
  el.defaultMuted = true;
  el.setAttribute('muted', '');
  el.playsInline = true;
  if (el.getAttribute('src') !== src) {
    el.setAttribute('src', src);
    el.load();
  }
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
    const showing = front === 'a' ? a.current : b.current;
    const waiting = front === 'a' ? b.current : a.current;
    if (!showing || !waiting) return;

    arm(showing, reel[index % reel.length].film);
    showing.play().catch(() => {});

    // Stage the next film behind the visible one so the swap has no gap.
    if (reel.length > 1) arm(waiting, reel[(index + 1) % reel.length].film);

    const advance = () => {
      if (reel.length < 2) {
        showing.currentTime = 0;
        showing.play().catch(() => {});
        return;
      }
      waiting.currentTime = 0;
      waiting.play().catch(() => {});
      setFront((f) => (f === 'a' ? 'b' : 'a'));
      setIndex((i) => (i + 1) % reel.length);
    };
    showing.addEventListener('ended', advance);
    return () => showing.removeEventListener('ended', advance);
  }, [index, front, reel, reduced]);

  const poster = reel[index % reel.length]?.still;
  if (reduced) return <img className={className} src={poster} alt="" />;

  return (
    <>
      <video
        ref={a}
        className={`${className ?? ''} mk-film-layer${front === 'a' ? ' on' : ''}`}
        autoPlay
        muted
        playsInline
        preload="auto"
        poster={poster}
      />
      <video
        ref={b}
        className={`${className ?? ''} mk-film-layer${front === 'b' ? ' on' : ''}`}
        autoPlay
        muted
        playsInline
        preload="auto"
      />
    </>
  );
}
