/**
 * Loading placeholder: a softly pulsing tint block in the shape of the
 * content it stands in for. Replaces full-screen spinners so a loading
 * screen keeps the page's real silhouette. Pulse is opacity-only (native
 * driver) and freezes under reduced motion.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii } from '../theme';
import { useReducedMotion } from './motion';

export function Skeleton({
  width,
  height,
  radius = radii.m,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (reduced) {
      pulse.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.5,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  return (
    <Animated.View
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: radius,
          backgroundColor: colors.neutralTint,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}
