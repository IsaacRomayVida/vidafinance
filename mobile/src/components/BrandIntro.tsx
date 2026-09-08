/**
 * Cold-start brand film: one of the moments credit buys — the service door
 * at dawn, the pharmacy counter, the school backpack, the kitchen exhale.
 * Documentary photography, never illustration. As the scene settles the
 * mark blooms with a soft ring and a haptic, the label rises, and the
 * curtain fades the app in. Drawn at random per cold start.
 *
 * The doorway still sits under the video as poster and failure fallback.
 * ~5.8s total, tap anywhere to skip. Under reduced motion: artwork only,
 * fast opacity fade, no video.
 */
import * as Haptics from 'expo-haptics';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Asset } from 'expo-asset';
import { colors } from '../theme';
import { FunpayMark, FunpayWordmark } from './FunpayLogo';
import { useReducedMotion } from './motion';

// Metro needs static requires — the whole set ships (~2 MB total).
/* eslint-disable @typescript-eslint/no-var-requires */
const artwork = require('../../assets/brand/home-doorway.jpg');
// Five moments of freedom, each ending on the cream-and-sage kite
// (~0.4 MB each after grading). One is drawn per cold start.
const SCENES = [
  require('../../assets/intros/intro-doorway.mp4'),
  require('../../assets/intros/intro-pharmacy.mp4'),
  require('../../assets/intros/intro-backpack.mp4'),
  require('../../assets/intros/intro-kitchen.mp4'),
];
/* eslint-enable @typescript-eslint/no-var-requires */

const bloom = Easing.bezier(0.23, 1, 0.32, 1);

function SceneFilm({ source }: { source: number }) {
  // Web: a real <video> (expo-video's web player freezes on the poster and
  // never autoplays muted, which is why the films looked like static images
  // in the portal). Native keeps expo-video.
  if (Platform.OS === 'web') {
    const { WebVideo } = require('./WebVideo');
    const uri = Asset.fromModule(source).uri;
    const posterUri = Asset.fromModule(artwork).uri;
    return <WebVideo uri={uri} loop={false} poster={posterUri} />;
  }
  return <NativeScene source={source} />;
}

function NativeScene({ source }: { source: number }) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.muted = true;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

export function BrandIntro({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const [scene] = useState(() => SCENES[Math.floor(Math.random() * SCENES.length)]);
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

    // Timed to the 5s scenes: the film breathes alone, then as the papalote
    // holds the sky the brand arrives, and the curtain hands over the app.
    Animated.sequence([
      Animated.delay(3300),
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
      Animated.timing(word, { toValue: 1, duration: 360, easing: bloom, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(curtain, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(finish);

    const haptic = setTimeout(
      () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
      3450
    );
    return () => clearTimeout(haptic);
  }, [mark, ring, word, curtain, reduced, finish]);

  if (finished) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { opacity: curtain }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={skip} accessibilityLabel="saltar intro">
        {/* Poster + fallback ground, always beneath the film. */}
        <Image source={artwork} style={styles.artwork} resizeMode="cover" />
        {!reduced ? <SceneFilm source={scene} /> : null}

        <View style={styles.center} pointerEvents="none">
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
            <FunpayWordmark size={18} color="#f4f7ee" />
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 10, backgroundColor: colors.cream },
  artwork: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' },
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
    borderColor: 'rgba(255,255,255,0.8)',
  },
});
