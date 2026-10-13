import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

interface PageTransitionProps {
  children: React.ReactNode;
}

/** One navigation: the page fades out, then back in — 0.25s each way. */
export const PAGE_FADE_MS = 500;
const PAGE_FADE: Keyframe[] = [
  { opacity: 1, easing: 'ease-in-out' },
  { opacity: 0, easing: 'ease-in-out' },
  { opacity: 1 },
];

/**
 * Wraps route content with an opacity fade on navigation (0.25s out, 0.25s
 * in, ease-in-out). The first route renders visible: fading it in from 0
 * only delayed the first paint / LCP on page load. Respects
 * `prefers-reduced-motion`.
 *
 * The fade is a single Web Animations API call rather than a motion
 * `AnimatePresence`: this wrapper is on every marketing page, and the
 * animation library was 28–40 KB gzip of their critical JavaScript for one
 * opacity tween. (The portals still use motion, in their own lazy chunks.)
 */
export function PageTransition({ children }: PageTransitionProps) {
  const { pathname } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef(pathname);

  const reduced =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useLayoutEffect(() => {
    // Only a change of route fades; the first page (and a re-run of this
    // effect for the same route) does not.
    if (shown.current === pathname) return;
    shown.current = pathname;
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    const fade = el.animate(PAGE_FADE, { duration: PAGE_FADE_MS });
    return () => fade.cancel();
  }, [pathname]);

  if (reduced) return <>{children}</>;

  return (
    <div ref={ref} key={pathname} style={{ willChange: 'opacity' }}>
      {children}
    </div>
  );
}
