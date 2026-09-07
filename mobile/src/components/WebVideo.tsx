/**
 * A real HTML5 <video> for web, rendered through react-native-web's
 * unstable_createElement so it accepts DOM attributes RN's own components
 * don't expose (autoPlay, muted, loop, playsInline).
 *
 * Why not expo-video's VideoView on web: its web player does not reliably
 * start muted-autoplay — it paints the poster/first frame and waits, which
 * reads as a frozen "static image" in the team portal. A native <video>
 * with muted+autoplay+playsInline is the one combination browsers are
 * REQUIRED to autoplay, so the brand films actually move on the web export.
 *
 * Native builds never import this — callers branch on Platform.OS and use
 * expo-video there.
 */
import React, { useEffect, useRef } from 'react';
import * as ReactNative from 'react-native';

// react-native-web re-exports unstable_createElement from the 'react-native'
// alias on web; it is absent from RN's types, so reach it through a cast.
const createElement = (ReactNative as unknown as {
  unstable_createElement: (
    tag: string,
    props: Record<string, unknown>
  ) => React.ReactElement;
}).unstable_createElement;

export function WebVideo({
  uri,
  loop = true,
  style,
  onEnded,
}: {
  uri: string;
  loop?: boolean;
  style?: React.CSSProperties;
  onEnded?: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Belt-and-suspenders: some browsers only honor muted autoplay when the
    // property (not just the attribute) is set before play() is invoked.
    el.muted = true;
    const tryPlay = () => {
      const p = el.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    tryPlay();
    el.addEventListener('canplay', tryPlay, { once: true });
    return () => el.removeEventListener('canplay', tryPlay);
  }, [uri]);

  return createElement('video', {
    ref,
    src: uri,
    autoPlay: true,
    muted: true,
    loop,
    playsInline: true,
    // iOS Safari reads the lowercase attribute form:
    'webkit-playsinline': 'true',
    preload: 'auto',
    onEnded,
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      display: 'block',
      ...style,
    },
  });
}
