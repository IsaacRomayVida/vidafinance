/**
 * The papalote: the brand's freedom loop (a teal-and-gold kite in a dawn
 * sky) drifting dimmed behind the Login glass. Muted, looping, cover-fit,
 * washed with the app's own light ground so the form stays the focal point.
 *
 * Web renders a real <video> (WebVideo) because expo-video's web player
 * does not reliably muted-autoplay — it freezes on the poster. Native uses
 * expo-video. Either way the Backdrop gradient shows through until the
 * first frame paints, so there is never a black flash.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Asset } from 'expo-asset';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const source = require('../../assets/brand-loop.mp4');

function NativeLoop() {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={[StyleSheet.absoluteFill, styles.video]}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

function WebLoop() {
  // Lazy import keeps react-native-web's unstable_createElement out of the
  // native bundle.
  const { WebVideo } = require('./WebVideo');
  const uri = Asset.fromModule(source).uri;
  return <WebVideo uri={uri} style={{ opacity: 0.6 }} />;
}

export function LoginVideoBackdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Platform.OS === 'web' ? <WebLoop /> : <NativeLoop />}
      {/* Bottom-weighted scrim: clear where the sky is calm, heavy where the
          kite gets loud — contrast defense at the backdrop's busiest region. */}
      <LinearGradient
        colors={['rgba(247,251,250,0.15)', 'rgba(247,251,250,0.45)', 'rgba(247,251,250,0.88)']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  video: { opacity: 0.6 },
});
