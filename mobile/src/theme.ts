/**
 * FunPay design tokens — the brand's own palette (public-v2
 * styles/legacy.css :root + public/favicon.svg) composed in the
 * light-glassmorphism language of the reference fintech interfaces:
 * a light aqua-lit ground, frosted translucent surfaces floating over
 * soft color, and the deep brand teal as the DARK element on top — the
 * hero card and the CTAs — never as the ground.
 */
export const colors = {
  // Brand core (web: --brand / --brand-mid / --brand-light)
  brand: '#194445',
  brandMid: '#1d5253',
  brandLight: '#247a6e',
  // Accents (web: --aqua / --aqua-soft / --gold)
  aqua: '#a8d5d0',
  aquaSoft: '#dceeed',
  gold: '#a28657',
  goldSoft: '#f4ede1',
  // Light ground (web: --bg / --bg2) — the gradient backdrop runs
  // bgTop → bgBottom with color blobs behind the glass.
  bg: '#f7fbfa',
  bgTop: '#f7fbfa',
  bgBottom: '#e3f0ee',
  // Glass surfaces: translucent white over the lit ground.
  glass: 'rgba(255,255,255,0.58)',
  glassStrong: 'rgba(255,255,255,0.78)',
  glassBorder: 'rgba(255,255,255,0.70)',
  hairline: 'rgba(25,68,69,0.10)',
  // Text scale (web: --t1 / --t2 / --t3)
  text: '#0c1e1f',
  subtle: '#4a6364',
  faint: '#93aaa9',
  danger: '#b3261e',
  dangerSoft: 'rgba(179,38,30,0.12)',
  onBrand: '#ffffff',
  // Tinted chip fills over glass
  aquaTint: 'rgba(36,122,110,0.14)',
  goldTint: 'rgba(162,134,87,0.16)',
  neutralTint: 'rgba(25,68,69,0.08)',
  // Aliases kept for existing styles
  primary: '#194445',
  primaryText: '#ffffff',
  chipBg: '#dceeed',
  bg2: '#eef5f3',
  border: 'rgba(25,68,69,0.10)',
};

/** The dark hero-card / CTA gradient: brand teal into its living green. */
export const gradient = ['#194445', '#247a6e'] as [string, string];

/** The backdrop wash behind everything. */
export const backdropGradient = ['#f7fbfa', '#e3f0ee'] as [string, string];

// expo-google-fonts family names — use fontFamily alone, never with
// fontWeight (Android would substitute a synthetic weight).
export const fonts = {
  display: 'DMSerifDisplay_400Regular',
  sans: 'DMSans_400Regular',
  sansMedium: 'DMSans_500Medium',
  sansBold: 'DMSans_700Bold',
};

export const radii = { s: 10, m: 14, l: 20, xl: 28, pill: 999 } as const;

export const spacing = { xs: 4, s: 8, m: 16, l: 24, xl: 32 } as const;

/**
 * Motion vocabulary — one timing language for the whole app.
 * Fast enough to be felt, never watched; entrances rise 12–16pt and fade,
 * presses settle at 0.97. Anything slower than 300ms is for rare moments
 * (the success screen), not for controls.
 */
export const motion = {
  press: 120,
  enter: 220,
  slow: 320,
  stagger: 45,
  rise: 14,
  pressScale: 0.97,
} as const;

/** Type scale (minor third off a 15px body; display sizes track tighter). */
export const type = {
  display: 32,
  title: 24,
  heading: 19,
  body: 15,
  small: 13,
  micro: 11,
} as const;

/** Uppercase letterspaced micro-label, the web app's form-label idiom. */
export const microLabel = {
  fontFamily: fonts.sansBold,
  fontSize: 11,
  letterSpacing: 1.8,
  textTransform: 'uppercase' as const,
  color: colors.faint,
};
