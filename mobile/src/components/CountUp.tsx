/**
 * Animated money figure: counts from 0 (or the previous value) to the target
 * with the same ease-out the rest of the app speaks, in tabular numerals so
 * the layout never jitters. Falls back to a static value under reduced
 * motion. Drives Text via a listener — RN can't native-drive text content,
 * and at ~600ms this is cheap.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, type StyleProp, type TextStyle } from 'react-native';

import { formatMxn } from '../lib/money';
import { useReducedMotion } from './motion';

export function CountUpMxn({
  value,
  style,
  duration = 650,
}: {
  value: number;
  style?: StyleProp<TextStyle>;
  duration?: number;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const fromRef = useRef(0);
  const [display, setDisplay] = useState(() => formatMxn(reduced ? value : 0));

  useEffect(() => {
    if (reduced) {
      setDisplay(formatMxn(value));
      return;
    }
    const from = fromRef.current;
    progress.setValue(0);
    const id = progress.addListener(({ value: t }) => {
      setDisplay(formatMxn(Math.round(from + (value - from) * t)));
    });
    Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: false,
    }).start(() => {
      fromRef.current = value;
      setDisplay(formatMxn(value));
    });
    return () => progress.removeListener(id);
  }, [value, reduced, duration, progress]);

  return (
    <Text style={[style, { fontVariant: ['tabular-nums'] }]} accessibilityLabel={formatMxn(value)}>
      {display}
    </Text>
  );
}
