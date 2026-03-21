export function VidaLogo({ variant = 'default' }: { variant?: 'default' | 'footer' }) {
  const c = variant === 'footer' ? 'rgba(255,255,255,0.7)' : '#1c4b4a';
  return (
    <span className={`vida-logo ${variant === 'footer' ? 'ft' : ''}`} aria-label="VIDA">
      <svg className="vida-logo-full" viewBox="0 0 920 282" xmlns="http://www.w3.org/2000/svg">
        <g className="vida-logo-v">
          <path fill={c} d="M0,0h44l78,203L199,0h44L136,281H107Z" />
        </g>
        <g className="vida-logo-ida">
          <rect fill={c} x="295" y="0" width="41" height="281" />
          <rect fill={c} x="400" y="0" width="41" height="281" />
          <path fill={c} d="M491,0c78,0,141,63,141,140s-63,141-141,141H441v-41h50c55,0,99-45,99-100s-45-99-99-99H441V0h50Z" />
          <path fill={c} d="M770,0h29L906,281H862L785,78,707,281H663L770,0Z" />
        </g>
      </svg>
    </span>
  );
}
