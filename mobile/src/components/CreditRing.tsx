/**
 * The credit gauge: a slim ring that charges up to the available fraction of
 * the line — the borrower's "battery". Gold on deep teal, animated with the
 * house ease via stroke-dashoffset (SVG props animate on the JS thread; at
 * 800ms once per screen this is cheap). Static under reduced motion.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { colors, fonts } from '../theme';
import { useReducedMotion } from './motion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function CreditRing({
  ratio,
  size = 58,
  stroke = 5,
}: {
  /** Available fraction of the credit line, 0..1. */
  ratio: number;
  size?: number;
  stroke?: number;
}) {
  const reduced = useReducedMotion();
  const clamped = Math.min(Math.max(ratio, 0), 1);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = useRef(new Animated.Value(reduced ? clamped : 0)).current;
  const [percent, setPercent] = useState(reduced ? Math.round(clamped * 100) : 0);

  useEffect(() => {
    if (reduced) {
      progress.setValue(clamped);
      setPercent(Math.round(clamped * 100));
      return;
    }
    const id = progress.addListener(({ value }) => setPercent(Math.round(value * 100)));
    Animated.timing(progress, {
      toValue: clamped,
      duration: 800,
      delay: 300,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: false,
    }).start();
    return () => progress.removeListener(id);
  }, [clamped, reduced, progress]);

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityLabel={`${Math.round(clamped * 100)}% disponible`}
    >
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="rgba(255,255,255,0.22)"
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colors.gold}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={progress.interpolate({
            inputRange: [0, 1],
            outputRange: [circumference, 0],
          })}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill}>
        <View style={styles.center}>
          <Text style={styles.percent}>{percent}%</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  percent: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    color: colors.onBrand,
    fontVariant: ['tabular-nums'],
  },
});
