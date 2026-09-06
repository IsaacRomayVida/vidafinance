/**
 * Cold-start brand moment: the mark blooms in over the lit ground, holds a
 * beat, then hands the screen to the app with a fade. Pure transform/opacity
 * on the native driver — zero asset weight, ~1.4s total, and under reduced
 * motion it collapses to a quick opacity-only fade so nobody is made to wait
 * on decoration.
 */
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { FunpayMark, FunpayWordmark } from './FunpayLogo';
import { Backdrop } from './Glass';
import { useReducedMotion } from './motion';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loop = require('../../assets/brand-loop.mp4');

/** The papalote, full-bleed and washed, under the blooming mark. */
function IntroVideo() {
  const player = useVideoPlayer(loop, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, { opacity: 0.65 }]}
        contentFit="cover"
        nativeControls={false}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(247,251,250,0.35)' }]} />
    </View>
  );
}

const bloom = Easing.bezier(0.23, 1, 0.32, 1);

export function BrandIntro({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const mark = useRef(new Animated.Value(0)).current;
  const word = useRef(new Animated.Value(0)).current;
  const curtain = useRef(new Animated.Value(1)).current;
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const show = reduced
      ? Animated.parallel([
          Animated.timing(mark, { toValue: 1, duration: 240, useNativeDriver: true }),
          Animated.timing(word, { toValue: 1, duration: 240, useNativeDriver: true }),
        ])
      : Animated.stagger(140, [
          Animated.spring(mark, {
            toValue: 1,
            useNativeDriver: true,
            damping: 14,
            stiffness: 160,
            mass: 0.9,
          }),
          Animated.timing(word, {
            toValue: 1,
            duration: 320,
            easing: bloom,
            useNativeDriver: true,
          }),
        ]);

    Animated.sequence([
      show,
      Animated.delay(reduced ? 120 : 900),
      Animated.timing(curtain, {
        toValue: 0,
        duration: reduced ? 160 : 300,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => {
      setFinished(true);
      onDone();
    });
  }, [mark, word, curtain, reduced, onDone]);

  if (finished) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { opacity: curtain }]} pointerEvents="none">
      <Backdrop>
        {!reduced ? <IntroVideo /> : null}
        <Animated.View
          style={[
            styles.center,
            {
              opacity: mark,
              transform: reduced
                ? []
                : [
                    {
                      scale: mark.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.7, 1],
                      }),
                    },
                  ],
            },
          ]}
        >
          <FunpayMark size={76} />
          <Animated.View style={{ opacity: word, marginTop: 18 }}>
            <FunpayWordmark size={26} />
          </Animated.View>
        </Animated.View>
      </Backdrop>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 10, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
