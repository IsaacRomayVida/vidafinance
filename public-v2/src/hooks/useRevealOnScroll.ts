import { useEffect } from 'react';

/**
 * Adds the `.vis` class to elements with class `.rv` when they scroll into view.
 *
 * Works with lazily-mounted sections (React.lazy / Suspense): a MutationObserver
 * watches for `.rv` elements added to the DOM after the initial mount and starts
 * observing them too. Without this, below-the-fold sections that load after the
 * hook runs would never be observed and stay stuck at opacity:0.
 *
 * Respects `prefers-reduced-motion`: when set, elements are marked visible
 * immediately (no scroll-triggered animation).
 */
export function useRevealOnScroll() {
  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('vis');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
    );

    const reveal = (el: Element) => {
      if (el.classList.contains('vis')) return;
      if (prefersReduced) {
        el.classList.add('vis');
      } else {
        io.observe(el);
      }
    };

    document.querySelectorAll('.rv').forEach(reveal);

    // Catch `.rv` nodes added by lazily-loaded sections.
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.classList.contains('rv')) reveal(node);
          node.querySelectorAll?.('.rv').forEach(reveal);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
}
