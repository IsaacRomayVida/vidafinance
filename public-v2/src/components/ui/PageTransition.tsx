import { useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

interface PageTransitionProps {
  children: React.ReactNode;
}

/**
 * One navigation: the wrapper dips to transparent and back, 0.25s each way.
 * The dip plays on the INCOMING page (see the note on the component).
 */
export const PAGE_FADE_MS = 500;
const PAGE_FADE: Keyframe[] = [
  { opacity: 1, easing: 'ease-in-out' },
  { opacity: 0, easing: 'ease-in-out' },
  { opacity: 1 },
];

/**
 * Wraps route content with an opacity dip on navigation (0.25s out, 0.25s
 * in, ease-in-out). The first route renders visible: fading it in from 0
 * only delayed the first paint / LCP on page load. Respects
 * `prefers-reduced-motion`.
 *
 * What is on screen during the dip: every caller passes `<Outlet />`, and an
 * Outlet always renders the CURRENT route. So the new page replaces the old
 * one in the same commit and it is the new page that fades out and back in;
 * the old page is not held. That is not new: the motion
 * `AnimatePresence mode="wait"` this replaced kept the exiting wrapper, but
 * the `<Outlet />` inside it had already switched to the new route, so it
 * showed the same thing (new page at opacity 1, down to 0, back to 1).
 * Fading the old page out for real needs a frozen outlet (`useOutlet()` held
 * in state) and is a motion change, not a delivery one.
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
