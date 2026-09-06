/**
 * The celebration: a single restrained burst of gold and aqua motes rising
 * and fading — fired once on a success moment, never looping, never confetti
 * carpet-bombing. Pure transform/opacity on the native driver; renders
 * nothing under reduced motion.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { useReducedMotion } from './motion';

const COUNT = 14;

export function GoldBurst({ size = 260 }: { size?: number }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 1100,
      delay: 150,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, reduced]);

  if (reduced) return null;

  return (
    <View style={[styles.host, { width: size, height: size }]} pointerEvents="none">
      {Array.from({ length: COUNT }, (_, i) => {
        const angle = (i / COUNT) * Math.PI * 2;
        const distance = size * (0.32 + (i % 3) * 0.09);
        const dot = 4 + (i % 3) * 2;
        const gold = i % 3 !== 2;
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              left: size / 2 - dot / 2,
              top: size / 2 - dot / 2,
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: gold ? colors.gold : colors.brandLight,
              opacity: progress.interpolate({
                inputRange: [0, 0.15, 0.75, 1],
                outputRange: [0, 1, 0.9, 0],
              }),
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.cos(angle) * distance],
                  }),
                },
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, Math.sin(angle) * distance - size * 0.08],
                  }),
                },
                {
                  scale: progress.interpolate({
                    inputRange: [0, 0.2, 1],
                    outputRange: [0.4, 1, 0.7],
                  }),
                },
              ],
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', alignSelf: 'center' },
});
