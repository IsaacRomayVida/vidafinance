// Regulatory compliance bar
export function LogosBar() {
  return (
    <div style={{
      borderBottom: '1px solid rgba(25,68,69,0.04)',
      padding: '24px 0',
    }}>
      <div style={{
        maxWidth: 'var(--mx, 1200px)', margin: '0 auto', padding: '0 64px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 40,
        flexWrap: 'wrap',
      }}>
        {/* SOFOM badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5" opacity={0.4}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
          </svg>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#93aaa9', letterSpacing: '0.5px' }}>
            SOFOM E.N.R. regulada
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: 'rgba(25,68,69,0.08)' }} />

        {/* CNBV */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5" opacity={0.35}>
            <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8M12 8v8" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#93aaa9', letterSpacing: '1px' }}>
            CNBV
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: 'rgba(25,68,69,0.08)' }} />

        {/* CONDUSEF */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#194445" strokeWidth="1.5" opacity={0.35}>
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#93aaa9', letterSpacing: '1px' }}>
            CONDUSEF
          </span>
        </div>
      </div>
    </div>
  );
}
