/**
 * A real HTML5 <video> for web that is actually allowed to autoplay.
 *
 * Browsers permit autoplay only when the element is muted AT THE MOMENT the
 * source is attached. React does not reliably apply the `muted` attribute
 * during render (facebook/react#10389), so a `<video autoPlay muted>` written
 * as JSX is evaluated by the browser as UNMUTED, refused, and left frozen on
 * its first frame — which is exactly what the portal showed.
 *
 * So the element is created with NO source. Once it is in the DOM we set the
 * muted property, then attach the source, then load and play. Muted is true
 * before a source exists, so the autoplay gate never closes.
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
  poster,
  style,
  onEnded,
}: {
  uri: string;
  loop?: boolean;
  /** Shown until the first frame paints; also the frame a refusal falls back to. */
  poster?: string;
  style?: React.CSSProperties;
  onEnded?: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    // Order matters: mute, then give it something to play.
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute('muted', '');
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.loop = loop;

    if (el.getAttribute('src') !== uri) {
      el.setAttribute('src', uri);
      el.load();
    }

    const play = () => {
      if (cancelled) return;
      const p = el.play?.();
      // A refusal leaves the poster showing rather than a black box.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    play();
    el.addEventListener('loadeddata', play);
    el.addEventListener('canplay', play);
    // Some browsers only release the gate after the first interaction; take it.
    const onFirstTouch = () => play();
    document.addEventListener('pointerdown', onFirstTouch, { once: true, passive: true });

    return () => {
      cancelled = true;
      el.removeEventListener('loadeddata', play);
      el.removeEventListener('canplay', play);
      document.removeEventListener('pointerdown', onFirstTouch);
    };
  }, [uri, loop]);

  return createElement('video', {
    ref,
    // NO src here — the effect attaches it after muting.
    autoPlay: true,
    muted: true,
    loop,
    playsInline: true,
    'webkit-playsinline': 'true',
    preload: 'auto',
    poster,
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
