/**
 * Surfaces of the funpay-ui language.
 *
 * Backdrop 'board' — the cream→sage vertical gradient every borrower screen
 * sits on. 'paper' — flat cream for capture screens (request, repayment,
 * forms). 'leaf' — a painted colour field (olive rising from the bottom,
 * cream light in the upper third) that stands in for the graded people
 * photograph until it ships; no botanical texture, per Isaac.
 *
 * GlassCard — the frosted chip: thin white fill, real blur, hairline edge,
 * inset top highlight. Only over the leaf; never glass over flat colour.
 */
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, ImageBackground, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';

import { boardGradient, colors, radii } from '../theme';

/* eslint-disable @typescript-eslint/no-var-requires */
const PHOTOS = {
  doorway: require('../../assets/brand/home-doorway.jpg'),
  stall: require('../../assets/brand/home-doorway.jpg'),
};
/* eslint-enable @typescript-eslint/no-var-requires */

export function Backdrop({
  children,
  variant = 'board',
  photo = 'doorway',
}: {
  children: React.ReactNode;
  variant?: 'board' | 'paper' | 'leaf' | 'photo';
  /** Which graded photograph carries the 'photo' variant. */
  photo?: keyof typeof PHOTOS;
}) {
  if (variant === 'photo') {
    // The people photograph, with a scrim that keeps the upper third light
    // and turns the lower half dark so cream type and the chips read.
    return (
      <ImageBackground source={PHOTOS[photo]} style={styles.fill} resizeMode="cover">
        <LinearGradient
          colors={['rgba(20,32,18,0.05)', 'rgba(20,32,18,0.35)', 'rgba(20,32,18,0.82)']}
          locations={[0.15, 0.55, 1]}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </ImageBackground>
    );
  }
  if (variant === 'paper') {
    return <View style={[styles.fill, { backgroundColor: colors.cream }]}>{children}</View>;
  }
  if (variant === 'leaf') {
    return (
      <LinearGradient colors={['#c9d5a3', '#6f8340', '#2c421c']} locations={[0, 0.4, 1]} style={styles.fill}>
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none" width="100%" height="100%">
          <Defs>
            <RadialGradient id="l1" cx="62%" cy="38%" rx="75%" ry="55%">
              <Stop offset="0%" stopColor="#5e7a34" stopOpacity="0.85" />
              <Stop offset="70%" stopColor="#6e8a3c" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="l2" cx="50%" cy="50%" rx="40%" ry="75%">
              <Stop offset="0%" stopColor="#47611f" stopOpacity="1" />
              <Stop offset="80%" stopColor="#47611f" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="l3" cx="35%" cy="92%" rx="70%" ry="45%">
              <Stop offset="0%" stopColor="#2f4a22" stopOpacity="0.9" />
              <Stop offset="75%" stopColor="#2f4a22" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="l4" cx="80%" cy="8%" rx="70%" ry="50%">
              <Stop offset="0%" stopColor="#ecf0d6" stopOpacity="1" />
              <Stop offset="75%" stopColor="#ecf0d6" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#l4)" />
          <Rect width="100%" height="100%" fill="url(#l3)" />
          <Ellipse cx="50%" cy="50%" rx="40%" ry="75%" fill="url(#l2)" />
          <Ellipse cx="62%" cy="38%" rx="75%" ry="55%" fill="url(#l1)" />
        </Svg>
        {children}
      </LinearGradient>
    );
  }
  return (
    <LinearGradient colors={boardGradient} locations={[0, 0.48, 1]} style={styles.fill}>
      {children}
    </LinearGradient>
  );
}

/** iOS "reduce transparency": glass collapses to a solid pane. */
function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled?.()
      .then((v) => mounted && setReduced(!!v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceTransparencyChanged', setReduced);
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

/** The frosted chip (the skill's `.trip`): thin fill, blur, lit top edge. */
export function GlassCard({
  children,
  style,
  intensity = 40,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
}) {
  const solid = useReducedTransparency();
  return (
    <View style={style}>
      <BlurView intensity={solid ? 0 : intensity} tint="light" style={styles.cardClip}>
        <View style={[styles.cardFill, solid && styles.cardSolid]}>
          <View style={styles.topEdge} />
          {children}
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cardClip: { borderRadius: radii.m, overflow: 'hidden' },
  cardFill: {
    backgroundColor: colors.glassLight,
    borderRadius: radii.m,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  cardSolid: { backgroundColor: 'rgba(255,255,255,0.86)' },
  topEdge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
});
