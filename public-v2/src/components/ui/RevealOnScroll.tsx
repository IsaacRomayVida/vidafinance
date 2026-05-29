import { useReducedMotion } from 'motion/react';
import { motion } from 'motion/react';

interface RevealOnScrollProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
  as?: string;
}

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Declarative scroll-reveal wrapper using Motion `whileInView`.
 * Respects `prefers-reduced-motion` — falls back to instant appearance.
 * Replaces the `.rv/.vis` + `useRevealOnScroll` pattern incrementally.
 */
export function RevealOnScroll({
  children,
  className,
  style,
  delay = 0,
}: RevealOnScrollProps) {
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}
