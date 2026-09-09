/**
 * The FunPay mark and label. The mark keeps the favicon's geometry (the F
 * built from three rounded bars, the dot) recoloured into the direction: an
 * ink tile, cream bars, and the dot in --cta — the one green on the mark.
 * The wordmark is now the Doto label `FUNPAY`, as the skill's brand mark.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../theme';

export function FunpayMark({ size = 44, tone = 'ink' }: { size?: number; tone?: 'ink' | 'cream' }) {
  const u = size / 48;
  const tile = tone === 'ink' ? colors.ink : colors.cream;
  const bar = tone === 'ink' ? colors.cream : colors.ink;
  return (
    <View style={{ width: size, height: size, borderRadius: 14 * u, backgroundColor: tile }} accessibilityLabel="FunPay">
      <View style={[styles.bar, { backgroundColor: bar, left: 15 * u, top: 12 * u, width: 6 * u, height: 24 * u, borderRadius: 3 * u }]} />
      <View style={[styles.bar, { backgroundColor: bar, left: 15 * u, top: 12 * u, width: 19 * u, height: 6 * u, borderRadius: 3 * u }]} />
      <View style={[styles.bar, { backgroundColor: bar, left: 15 * u, top: 21 * u, width: 14 * u, height: 6 * u, borderRadius: 3 * u }]} />
      <View
        style={{
          position: 'absolute',
          left: 30.5 * u,
          top: 30.5 * u,
          width: 6 * u,
          height: 6 * u,
          borderRadius: 3 * u,
          backgroundColor: colors.cta,
        }}
      />
    </View>
  );
}

export function FunpayWordmark({ size = 15, color = colors.ink }: { size?: number; color?: string }) {
  return (
    <Text
      style={{ fontFamily: fonts.dot, fontSize: size, letterSpacing: size * 0.06, color, textTransform: 'uppercase' }}
      accessibilityLabel="FunPay"
    >
      FunPay
    </Text>
  );
}

export function FunpayLogo({ markSize = 34, textSize = 15 }: { markSize?: number; textSize?: number }) {
  return (
    <View style={styles.row}>
      <FunpayMark size={markSize} />
      <FunpayWordmark size={textSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
