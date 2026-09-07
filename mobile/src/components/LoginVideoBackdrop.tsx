/**
 * The papalote: the brand's freedom loop (a teal-and-gold kite in a dawn
 * sky) drifting dimmed behind the Login glass. Muted, looping, cover-fit,
 * and washed with the app's own light ground so the form stays the focal
 * point — the video is atmosphere, not content.
 *
 * The parent gates rendering on reduced motion; until the first frame
 * renders the view is transparent, so the Backdrop gradient is the natural
 * fallback and there is never a black flash.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { StyleSheet, View } from 'react-native';

// Metro bundles the clip (≈3.7 MB) into the app.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const source = require('../../assets/brand-loop.mp4');

export function LoginVideoBackdrop() {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, styles.video]}
        contentFit="cover"
        nativeControls={false}
      />
      {/* Bottom-weighted scrim: clear where the sky is calm, heavy where the
          kite gets loud — contrast defense against the backdrop's brightest
          and busiest region. */}
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
