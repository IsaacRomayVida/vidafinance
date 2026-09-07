/**
 * Where is the app being shown? One React Native codebase renders three
 * ways: the phone (native or the portal's phone frame), the mobile web
 * (`?ui=web` at phone width) and the desktop web (`?ui=web` at ≥ 900px).
 *
 * `?ui=web` is set by the team portal's web frames. It means "this is a
 * website, not a phone": no brand intro, no splash film — a site shows its
 * content first. Width alone decides the desktop layout, so a real browser
 * at desktop size gets the desktop layout even without the param.
 */
import { Platform, useWindowDimensions } from 'react-native';

export const DESKTOP_MIN_WIDTH = 900;

export function readWebMode(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('ui') === 'web';
  } catch {
    return false;
  }
}

// Read once: the query string does not change while the app is mounted
// (react-navigation runs without linking here).
const WEB_MODE = readWebMode();

export function useLayout() {
  const { width } = useWindowDimensions();
  const isWeb = Platform.OS === 'web';
  return {
    isWeb,
    webMode: WEB_MODE,
    isDesktop: isWeb && width >= DESKTOP_MIN_WIDTH,
    width,
  };
}

/** Center content in a column of `maxWidth` on desktop; no-op elsewhere. */
export function useColumn(maxWidth: number) {
  const { isDesktop } = useLayout();
  return isDesktop ? ({ width: '100%', maxWidth, alignSelf: 'center' } as const) : null;
}
