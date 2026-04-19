import { useEffect } from 'react';

/**
 * Adds the `.vis` class to elements with class `.rv` when they scroll into view.
 * Respects `prefers-reduced-motion`: if user prefers reduced motion, elements are
 * marked visible immediately on mount (no scroll-triggered reveal animation).
 */
export function useRevealOnScroll() {
  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const elements = document.querySelectorAll('.rv');

    if (prefersReduced) {
      // Skip the reveal animation entirely — just mark everything visible.
      elements.forEach((el) => el.classList.add('vis'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('vis');
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
    );

    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);
}
