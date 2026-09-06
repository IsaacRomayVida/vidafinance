/**
 * Cold-start brand moment, choreographed: the papalote dawn artwork breathes
 * (slow Ken Burns drift) while a warm light sweep rises from the horizon;
 * the mark blooms with a gold ring pulse and a soft haptic; the wordmark
 * rises; then the curtain fades the app in. ~3s, tappable to skip, pure
 * transform/opacity on the native driver. Under reduced motion the whole
 * thing collapses to a quick opacity-only fade.
 */
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { FunpayMark, FunpayWordmark } from './FunpayLogo';
import { useReducedMotion } from './motion';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const artwork = require('../../assets/splash-artwork.png');

const bloom = Easing.bezier(0.23, 1, 0.32, 1);

export function BrandIntro({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const drift = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const mark = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const word = useRef(new Animated.Value(0)).current;
  const curtain = useRef(new Animated.Value(1)).current;
  const [finished, setFinished] = useState(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFinished(true);
    onDone();
  }, [onDone]);

  const skip = useCallback(() => {
    Animated.timing(curtain, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(finish);
  }, [curtain, finish]);

  useEffect(() => {
    if (reduced) {
      Animated.sequence([
        Animated.parallel([
          Animated.timing(mark, { toValue: 1, duration: 240, useNativeDriver: true }),
          Animated.timing(word, { toValue: 1, duration: 240, useNativeDriver: true }),
        ]),
        Animated.delay(150),
        Animated.timing(curtain, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(finish);
      return;
    }

    // The sky breathes for the whole moment.
    Animated.timing(drift, {
      toValue: 1,
      duration: 3400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    // Light rises from the horizon.
    Animated.timing(sweep, {
      toValue: 1,
      duration: 2200,
      delay: 200,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start();

    Animated.sequence([
      Animated.delay(500),
      Animated.parallel([
        Animated.spring(mark, {
          toValue: 1,
          useNativeDriver: true,
          damping: 12,
          stiffness: 150,
          mass: 0.9,
        }),
        Animated.timing(ring, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(word, { toValue: 1, duration: 380, easing: bloom, useNativeDriver: true }),
      Animated.delay(950),
      Animated.timing(curtain, {
        toValue: 0,
        duration: 380,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(finish);

    const haptic = setTimeout(
      () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
      620
    );
    return () => clearTimeout(haptic);
  }, [drift, sweep, mark, ring, word, curtain, reduced, finish]);

  if (finished) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { opacity: curtain }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={skip} accessibilityLabel="saltar intro">
        {/* The dawn, breathing. */}
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            reduced
              ? null
              : {
                  transform: [
                    { scale: drift.interpolate({ inputRange: [0, 1], outputRange: [1.0, 1.07] }) },
                    {
                      translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }),
                    },
                  ],
                },
          ]}
        >
          <Image source={artwork} style={styles.artwork} resizeMode="cover" />
        </Animated.View>

        {/* First light rising over the frame. */}
        {!reduced ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.sweep,
              {
                opacity: sweep.interpolate({
                  inputRange: [0, 0.5, 1],
                  outputRange: [0, 0.4, 0],
                }),
                transform: [
                  {
                    translateY: sweep.interpolate({ inputRange: [0, 1], outputRange: [260, -340] }),
                  },
                ],
              },
            ]}
          />
        ) : null}

        <View style={styles.center} pointerEvents="none">
          {/* Gold ring pulse behind the blooming mark. */}
          {!reduced ? (
            <Animated.View
              style={[
                styles.ring,
                {
                  opacity: ring.interpolate({
                    inputRange: [0, 0.25, 1],
                    outputRange: [0, 0.55, 0],
                  }),
                  transform: [
                    { scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2.1] }) },
                  ],
                },
              ]}
            />
          ) : null}
          <Animated.View
            style={{
              opacity: mark,
              transform: reduced
                ? []
                : [{ scale: mark.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }],
            }}
          >
            <FunpayMark size={84} />
          </Animated.View>
          <Animated.View
            style={{
              opacity: word,
              marginTop: 18,
              transform: reduced
                ? []
                : [{ translateY: word.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
            }}
          >
            <FunpayWordmark size={27} />
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 10, backgroundColor: colors.bg },
  artwork: { width: '100%', height: '100%' },
  sweep: {
    position: 'absolute',
    left: -80,
    right: -80,
    bottom: 0,
    height: 420,
    backgroundColor: colors.goldSoft,
    borderRadius: 210,
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: colors.gold,
  },
});
