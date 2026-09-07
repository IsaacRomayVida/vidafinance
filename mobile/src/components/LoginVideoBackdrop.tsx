/**
 * The papalote: the brand's freedom loop (a teal-and-gold kite in a dawn
 * sky). Two roles:
 *  - `wash` (phone): dimmed behind the Login glass, washed with the app's
 *    light ground so the form stays the focal point.
 *  - `hero` (desktop split-screen): full presence, with a dark scrim rising
 *    from the bottom so white type sits on it.
 *
 * Web renders a real <video> (WebVideo) because expo-video's web player
 * does not reliably muted-autoplay — it freezes on the poster. Native uses
 * expo-video. Either way the Backdrop shows through until the first frame
 * paints, so there is never a black flash.
 */
import { Asset } from 'expo-asset';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const source = require('../../assets/brand-loop.mp4');

const SCRIMS = {
  wash: {
    colors: ['rgba(247,251,250,0.15)', 'rgba(247,251,250,0.45)', 'rgba(247,251,250,0.88)'],
    opacity: 0.6,
  },
  hero: {
    colors: ['rgba(12,30,31,0.10)', 'rgba(12,30,31,0.35)', 'rgba(12,30,31,0.78)'],
    opacity: 1,
  },
} as const;

function NativeLoop({ opacity }: { opacity: number }) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, { opacity }]}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

function WebLoop({ opacity }: { opacity: number }) {
  // Lazy import keeps react-native-web's unstable_createElement out of the
  // native bundle.
  const { WebVideo } = require('./WebVideo');
  const uri = Asset.fromModule(source).uri;
  return <WebVideo uri={uri} style={{ opacity }} />;
}

export function LoginVideoBackdrop({ variant = 'wash' }: { variant?: 'wash' | 'hero' }) {
  const scrim = SCRIMS[variant];
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Platform.OS === 'web' ? (
        <WebLoop opacity={scrim.opacity} />
      ) : (
        <NativeLoop opacity={scrim.opacity} />
      )}
      {/* Bottom-weighted scrim: clear where the sky is calm, heavy where the
          kite gets loud — contrast defense at the backdrop's busiest region. */}
      <LinearGradient
        colors={[...scrim.colors]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
