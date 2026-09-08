/**
 * FunPay design tokens — the funpay-ui direction (.claude/skills/funpay-ui).
 *
 * Borrower side: cream→sage boards, ink (never #000) for type, Urbanist for
 * everything read and Doto for labels only, pill radii, and ONE saturated
 * control per screen in --cta green. Green is semantic — active, approved,
 * received — never decoration. The legacy aliases at the bottom keep every
 * untouched call site compiling and landing in the palette.
 */
const base = {
  void: '#0b0d0b',
  ink: '#1e201d',
  inkSoft: '#3a3d38',
  mute: '#5f6a5c',   // ≥4.5:1 on cream for 13px labels
  typeQuiet: '#7d8d77',

  cream: '#f3f4ec',
  creamMid: '#eaf0e3',
  sage: '#dbe9d6',
  mint: '#c9ecdc',
  moss: '#6f8a4a',
  mossDeep: '#2f4a22',
  peach: '#f2c4a0',
  sky: '#bcdde9',
  mark: '#d7f0dc',
  markInk: '#2c6a3c',
  cta: '#2fc04e',

  leafLight: '#e6ead0',
  leafMid: '#a6b46a',
  leafDark: '#354a1a',

  paper: '#e9ebe1',
  paperDark: '#f2f5f0',
  charcoal: '#000b1a',
  forest: '#1c4a30',
  harmony: '#68e78e',

  glassLight: 'rgba(255,255,255,0.14)',
  glassPass: 'rgba(255,255,255,0.34)',
  glassDark: 'rgba(20,24,20,0.72)',
  glassEdge: 'rgba(255,255,255,0.28)',

  danger: '#b3261e',
  dangerSoft: 'rgba(179,38,30,0.10)',
};

export const colors = {
  ...base,
  // ---- legacy aliases ----
  brand: base.ink,
  brandMid: base.inkSoft,
  brandLight: base.mossDeep,
  text: base.ink,
  subtle: base.inkSoft,
  faint: base.mute,
  onBrand: base.cream,
  bg: base.cream,
  bgTop: base.cream,
  bgBottom: base.sage,
  bg2: base.creamMid,
  gold: base.peach,
  goldSoft: '#f8f1ea',
  aqua: base.sage,
  aquaSoft: base.mint,
  glass: base.glassLight,
  glassStrong: 'rgba(255,255,255,0.72)',
  glassBorder: 'rgba(255,255,255,0.55)',
  glassHighlight: 'rgba(255,255,255,0.85)',
  glassShade: 'rgba(20,24,20,0.10)',
  hairline: 'rgba(30,32,29,0.10)',
  aquaTint: 'rgba(47,74,34,0.10)',
  goldTint: 'rgba(242,196,160,0.35)',
  neutralTint: 'rgba(30,32,29,0.07)',
  primary: base.ink,
  primaryText: base.cream,
  chipBg: base.paper,
  border: 'rgba(30,32,29,0.10)',
};

/** Ink pill gradient (kept for the few dark pills). */
export const gradient = [base.ink, base.inkSoft] as [string, string];
/** The board: cream at the top falling to sage. */
export const boardGradient = [base.cream, base.creamMid, base.sage] as [string, string, string];
export const backdropGradient = [base.cream, base.sage] as [string, string];
/** Acetate gradients — three-stop pastels, no blur. */
export const assistGradient = ['#cfe8d0', '#f3d2b4', '#c4e2ea'] as [string, string, string];
export const identGradient = ['#9fd8c2', '#cfe4c8', '#f0c8a4'] as [string, string, string];

// expo-google-fonts family names — use fontFamily alone, never with
// fontWeight (Android would substitute a synthetic weight).
export const fonts = {
  display: 'Urbanist_400Regular',
  sans: 'Urbanist_400Regular',
  sansLight: 'Urbanist_300Light',
  sansMedium: 'Urbanist_500Medium',
  sansBold: 'Urbanist_600SemiBold',
  dot: 'Doto_600SemiBold',
};

// Pills and boards: nothing under 18px — cards are panes, controls are pills.
export const radii = { s: 18, m: 20, l: 20, xl: 26, pill: 40 } as const;

export const spacing = { xs: 4, s: 8, m: 16, l: 24, xl: 32 } as const;

/** Motion: the caret blinks, the hero drifts, nothing else moves. */
export const motion = {
  press: 120,
  enter: 220,
  slow: 320,
  stagger: 45,
  rise: 14,
  pressScale: 0.97,
  caretBlink: 1100,
} as const;

/** Type scale from the skill: numeral hero, headline, title, body, label. */
export const type = {
  numeral: 50,
  amount: 64,
  display: 40,
  title: 22,
  heading: 19,
  body: 15,
  small: 13,
  micro: 11,
} as const;

/** The Doto label: uppercase, +6% tracking, muted. Labels only — never a
 *  sentence, never a button. */
export const dotLabel = {
  fontFamily: fonts.dot,
  fontSize: 13,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
  color: base.mute,
};
export const microLabel = dotLabel;

/** Shadows exist for floating and glass elements only. */
export const shadowFloat = {
  shadowColor: '#1e3c1e',
  shadowOpacity: 0.28,
  shadowRadius: 24,
  shadowOffset: { width: 0, height: 16 },
  elevation: 6,
} as const;
