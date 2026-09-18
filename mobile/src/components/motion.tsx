/**
 * Motion primitives — the app's entire animation vocabulary in one place.
 *
 * Everything runs on the native driver (transform/opacity only) and everything
 * respects the OS reduce-motion setting: movement collapses to a plain
 * opacity fade, presses stop scaling, and nothing else changes.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { motion } from '../theme';

/** True when the OS asks for reduced motion; live-updates if it changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

const enterEase = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * Entrance: fade + a short rise. `index` staggers siblings into a cascade.
 * Under reduced motion the rise is dropped and only the fade remains.
 */
export function FadeSlideIn({
  children,
  index = 0,
  style,
}: {
  children: React.ReactNode;
  index?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.enter,
      delay: index * motion.stagger,
      easing: enterEase,
      useNativeDriver: true,
    }).start();
  }, [progress, index]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: reduced
            ? []
            : [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [motion.rise, 0],
                  }),
                },
              ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A Pressable that settles to 0.97 scale while held — the tactile "the UI
 * heard you" cue used by every card, pill, and button in the app.
 */
export function PressableScale({
  children,
  style,
  disabled,
  ...rest
}: PressableProps & { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

  const to = (value: number) =>
    Animated.timing(scale, {
      toValue: value,
      duration: motion.press,
      easing: enterEase,
      useNativeDriver: true,
    }).start();

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        if (!reduced && !disabled) to(motion.pressScale);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        rest.onPressOut?.(e);
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
