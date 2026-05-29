interface BadgeProps {
  variant: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Wraps the `.badge .badge-{variant}` CSS classes from legacy.css.
 * Use this instead of scattering className logic in component trees.
 */
export function Badge({ variant, children, className, style }: BadgeProps) {
  return (
    <span
      className={`badge badge-${variant}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </span>
  );
}
