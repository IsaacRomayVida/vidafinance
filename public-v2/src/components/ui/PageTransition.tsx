import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

interface PageTransitionProps {
  children: React.ReactNode;
}

/**
 * Wraps route content with a 0.25s opacity fade on navigation.
 * Uses the pathname as the AnimatePresence key so each route change
 * triggers enter/exit. Respects `prefers-reduced-motion`.
 */
export function PageTransition({ children }: PageTransitionProps) {
  const { pathname } = useLocation();
  const reduced = useReducedMotion();

  if (reduced) return <>{children}</>;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25, ease: 'easeInOut' }}
        style={{ willChange: 'opacity' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
