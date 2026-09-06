/**
 * The glassmorphism primitives: a dawn-lit ground and frosted panes that
 * float over it.
 *
 * The ground is the brand's freedom metaphor made literal — first light:
 * cool aqua-mint air at the top falling to a warm gold glow low on the
 * horizon (the papalote's sky). No decorative blobs; the light itself is
 * the atmosphere.
 *
 * Real backdrop blur (expo-blur) frosts whatever sits behind the card,
 * which is what sells the glass. The translucent fill and the bright
 * hairline border carry the look even where blur is unavailable (older
 * Android), so the design degrades to "airy", never to "broken".
 */
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { colors, radii } from '../theme';

/** Full-screen dawn: cool light above, warm gold rising from the horizon. */
export function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <LinearGradient
      colors={['#f2f9f7', '#f7fbfa', '#faf3e6']}
      locations={[0, 0.55, 1]}
      style={styles.fill}
    >
      {/* The sun below the horizon: one soft gold radiance, low and wide,
          and the cool morning air above. */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id="dawn" cx="50%" cy="100%" rx="80%" ry="55%">
            <Stop offset="0%" stopColor={colors.gold} stopOpacity="0.28" />
            <Stop offset="55%" stopColor={colors.gold} stopOpacity="0.10" />
            <Stop offset="100%" stopColor={colors.gold} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="air" cx="18%" cy="0%" rx="70%" ry="45%">
            <Stop offset="0%" stopColor={colors.aqua} stopOpacity="0.30" />
            <Stop offset="100%" stopColor={colors.aqua} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50%" cy="108%" rx="95%" ry="60%" fill="url(#dawn)" />
        <Ellipse cx="18%" cy="-6%" rx="80%" ry="48%" fill="url(#air)" />
      </Svg>
      {children}
    </LinearGradient>
  );
}

/** A frosted card: blurred backdrop, translucent fill, bright edge. */
export function GlassCard({
  children,
  style,
  intensity = 40,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
}) {
  return (
    <View style={[styles.cardShadow, style]}>
      <BlurView intensity={intensity} tint="light" style={styles.cardClip}>
        <View style={styles.cardFill}>
          {/* The pane's light-catching top edge — what sells glass over tint. */}
          <View style={styles.topEdge} />
          {children}
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cardShadow: {
    borderRadius: radii.l,
    shadowColor: colors.brand,
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  cardClip: { borderRadius: radii.l, overflow: 'hidden' },
  cardFill: {
    backgroundColor: colors.glass,
    borderRadius: radii.l,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
  },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassHighlight,
  },
});
