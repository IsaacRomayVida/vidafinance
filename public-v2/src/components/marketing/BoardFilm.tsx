/**
 * A board's background, playing.
 *
 * Every photographic board carries the film generated from its own
 * photograph, with the still as the poster so there is never an empty frame
 * while it loads or if a browser refuses playback. The scrim lives here too:
 * a film has more tonal range than a still, so type over it needs a floor it
 * can rely on rather than whatever the frame happens to be doing.
 *
 * Muted is set BEFORE the source is attached — React does not apply the
 * attribute during render (facebook/react#10389), so `<video autoPlay muted>`
 * is evaluated as unmuted, refused by autoplay policy, and frozen.
 */
import { useEffect, useRef } from 'react';

export function BoardFilm({ film, still }: { film: string; still: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute('muted', '');
    el.playsInline = true;
    el.loop = true;
    if (el.getAttribute('src') !== film) {
      el.setAttribute('src', film);
      el.load();
    }
    const play = () => {
      const r = el.play?.();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    };
    play();
    el.addEventListener('canplay', play, { once: true });
    // Only decode while the board is on screen, where the browser supports
    // it. Without IntersectionObserver the film simply plays throughout.
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (es) => es.forEach((e) => (e.isIntersecting ? play() : el.pause())),
            { threshold: 0.1 }
          )
        : null;
    io?.observe(el);
    return () => {
      io?.disconnect();
      el.removeEventListener('canplay', play);
    };
  }, [film]);

  return (
    <div className="mk-board-film" aria-hidden="true">
      <img src={still} alt="" />
      <video ref={ref} autoPlay muted loop playsInline preload="metadata" poster={still} />
      <span className="mk-board-scrim" />
    </div>
  );
}
