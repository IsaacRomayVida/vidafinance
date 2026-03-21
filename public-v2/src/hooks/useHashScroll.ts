import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Scrolls to the element matching location.hash after navigation */
export function useHashScroll() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (!hash) return;
    // Small delay to let the DOM render after route change
    const id = hash.replace('#', '');
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, pathname]);
}
