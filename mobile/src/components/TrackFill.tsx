/**
 * Animated fill for slim progress tracks: grows to its ratio with the house
 * ease via a scaleX transform (native driver — animating width would layout
 * every frame). Anchored left with the translate/scale/translate trick since
 * RN transforms about the center. Static under reduced motion.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { radii } from '../theme';
import { useReducedMotion } from './motion';

export function TrackFill({
  ratio,
  color,
  height,
}: {
  ratio: number;
  color: string;
  height: number;
}) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      scale.setValue(1);
      return;
    }
    Animated.timing(scale, {
      toValue: 1,
      duration: 700,
      delay: 250,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: true,
    }).start();
  }, [scale, reduced]);

  const clamped = Math.min(Math.max(ratio, 0), 1);

  return (
    <View style={[styles.host, { height, width: `${clamped * 100}%` }]}>
      <Animated.View
        style={[
          styles.fill,
          {
            height,
            backgroundColor: color,
            transform: [{ scaleX: scale }],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { overflow: 'hidden', borderRadius: radii.pill },
  fill: { width: '100%', borderRadius: radii.pill, transformOrigin: 'left' },
});
