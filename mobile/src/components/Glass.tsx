/**
 * The glassmorphism primitives: a soft aqua-lit backdrop with color blobs,
 * and frosted cards that float over it.
 *
 * Real backdrop blur (expo-blur) frosts whatever sits behind the card —
 * the blobs — which is what sells the glass. The translucent fill and the
 * bright hairline border carry the look even where blur is unavailable
 * (older Android), so the design degrades to "airy", never to "broken".
 */
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { backdropGradient, colors, radii } from '../theme';

/** Full-screen lit ground: gradient wash + three soft brand-color blobs. */
export function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <LinearGradient colors={backdropGradient} style={styles.fill}>
      <View style={[styles.blob, styles.blobAqua]} />
      <View style={[styles.blob, styles.blobTeal]} />
      <View style={[styles.blob, styles.blobGold]} />
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
  blob: { position: 'absolute', opacity: 0.5 },
  blobAqua: {
    width: 340,
    height: 340,
    borderRadius: 170,
    backgroundColor: colors.aqua,
    top: -90,
    right: -110,
  },
  blobTeal: {
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: colors.brandLight,
    opacity: 0.22,
    top: 260,
    left: -140,
  },
  blobGold: {
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: colors.gold,
    opacity: 0.2,
    bottom: -60,
    right: -60,
  },
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
