import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * How far ahead of the viewport below-the-fold media starts loading — the
 * distance browsers use for native `loading="lazy"` on a fast connection.
 */
export const NEAR_VIEWPORT_MARGIN = '1250px 0px';

/**
 * True once the element has come within `margin` of the viewport, and from
 * then on (it never goes back to false). Use it to hold back media that
 * native lazy-loading cannot: CSS backgrounds and <video> sources, which a
 * page otherwise requests during load even when they sit several screens
 * down — in competition with the hero image that is the page's LCP.
 *
 * Without IntersectionObserver the media is simply not deferred.
 */
export function useNearViewport<T extends Element>(margin: string = NEAR_VIEWPORT_MARGIN): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver !== 'function');

  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: margin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);

  return [ref, near];
}
