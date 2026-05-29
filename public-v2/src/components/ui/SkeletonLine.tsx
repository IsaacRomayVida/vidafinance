interface SkeletonLineProps {
  width?: string | number;
  height?: number;
  borderRadius?: number;
  delay?: number;
}

/**
 * Single animated skeleton placeholder.
 * Uses the `skeletonPulse` keyframes (defined in index.css Phase 3).
 * Already works if skeletonPulse is in legacy.css.
 */
export function SkeletonLine({
  width = '100%',
  height = 12,
  borderRadius = 6,
  delay = 0,
}: SkeletonLineProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        background: 'rgba(25,68,69,0.05)',
        animation: 'skeletonPulse 1.5s ease-in-out infinite',
        animationDelay: `${delay}s`,
      }}
    />
  );
}

interface SkeletonRowProps {
  rows?: number;
}

/** Stack of SkeletonLine for typical list/table rows. */
export function SkeletonRows({ rows = 3 }: SkeletonRowProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            aria-hidden="true"
            style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'rgba(25,68,69,0.04)',
              animation: 'skeletonPulse 1.5s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SkeletonLine width="55%" height={11} delay={i * 0.15} />
            <SkeletonLine width="35%" height={9} delay={i * 0.15 + 0.05} />
          </div>
          <SkeletonLine width={50} height={20} borderRadius={10} delay={i * 0.15} />
        </div>
      ))}
    </div>
  );
}
