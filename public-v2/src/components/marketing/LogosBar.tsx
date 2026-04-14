// Logos bar

export function LogosBar() {
  return (
    <div style={{
      borderBottom: '1px solid rgba(25,68,69,0.04)',
      padding: '28px 0',
      overflow: 'hidden',
    }}>
      <div style={{
        maxWidth: 'var(--mx, 1200px)', margin: '0 auto', padding: '0 64px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 48,
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3, #93aaa9)', whiteSpace: 'nowrap' }}>
          Respaldado por
        </span>
        {/* Partner/integration logos as SVG text marks */}
        {[
          { name: 'Google Cloud', w: 90 },
          { name: 'Firebase', w: 60 },
          { name: 'MetaMap', w: 64 },
          { name: 'RiskSeal', w: 62 },
          { name: 'Conekta', w: 60 },
          { name: 'CNBV', w: 42 },
        ].map((logo) => (
          <span key={logo.name} style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 13, fontWeight: 600, color: 'var(--t3, #93aaa9)',
            opacity: 0.5, letterSpacing: '0.02em',
            transition: 'opacity 0.3s',
          }}
            onMouseEnter={(e: React.MouseEvent<HTMLSpanElement>) => (e.currentTarget.style.opacity = '0.8')}
            onMouseLeave={(e: React.MouseEvent<HTMLSpanElement>) => (e.currentTarget.style.opacity = '0.5')}
          >
            {logo.name}
          </span>
        ))}
      </div>
    </div>
  );
}
