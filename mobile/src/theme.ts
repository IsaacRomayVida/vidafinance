/**
 * FunPay design tokens — the mobile mirror of public-v2's brand system
 * (src/styles/legacy.css :root). Same deep teal, aqua, and gold; same
 * DM Serif Display / DM Sans pairing; same soft radii. If the web tokens
 * change, change these to match — the brand has exactly one source.
 */
export const colors = {
  // Brand core (web: --brand / --brand-mid / --brand-light)
  brand: '#194445',
  brandMid: '#1d5253',
  brandLight: '#247a6e',
  // Supporting palette (web: --aqua / --aqua-soft / --gold)
  aqua: '#a8d5d0',
  aquaSoft: '#dceeed',
  gold: '#a28657',
  goldSoft: '#f4ede1',
  // Surfaces (web: --bg / --bg2)
  bg: '#ffffff',
  bg2: '#f5f8f7',
  // Text scale (web: --t1 / --t2 / --t3)
  text: '#0c1e1f',
  subtle: '#4a6364',
  faint: '#93aaa9',
  border: 'rgba(25,68,69,0.10)',
  hairline: 'rgba(25,68,69,0.08)',
  danger: '#b3261e',
  dangerSoft: '#f9e9e7',
  onBrand: '#ffffff',
  // Aliases kept for existing styles: primary IS the brand teal.
  primary: '#194445',
  primaryText: '#ffffff',
  chipBg: '#dceeed',
};

// expo-google-fonts family names — use fontFamily alone, never with
// fontWeight (Android would substitute a synthetic weight).
export const fonts = {
  display: 'DMSerifDisplay_400Regular',
  sans: 'DMSans_400Regular',
  sansMedium: 'DMSans_500Medium',
  sansBold: 'DMSans_700Bold',
};

export const radii = { s: 8, m: 12, l: 16, xl: 20 } as const;

export const spacing = { xs: 4, s: 8, m: 16, l: 24, xl: 32 } as const;

/** Uppercase letterspaced micro-label, the web app's form-label idiom. */
export const microLabel = {
  fontFamily: fonts.sansBold,
  fontSize: 11,
  letterSpacing: 1.8,
  textTransform: 'uppercase' as const,
  color: colors.faint,
};
