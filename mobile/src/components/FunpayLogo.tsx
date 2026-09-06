/**
 * The FunPay brand mark and wordmark, exactly as the web app draws them.
 *
 * The mark reproduces public-v2/public/favicon.svg geometrically — a deep
 * teal rounded tile, the white F built from three rounded bars, and the
 * gold dot — using plain Views on the favicon's own 48-unit grid, so it
 * needs no SVG dependency and scales crisply at any size. The wordmark
 * matches .funpay-logo: DM Sans bold, tight letterspacing, brand teal
 * ("Funpay" with one capital, as the web renders it).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../theme';

export function FunpayMark({ size = 44 }: { size?: number }) {
  const u = size / 48;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 11 * u,
        backgroundColor: colors.brand,
      }}
      accessibilityLabel="Funpay"
    >
      <View style={[styles.bar, { left: 15 * u, top: 12 * u, width: 6 * u, height: 24 * u, borderRadius: 1.5 * u }]} />
      <View style={[styles.bar, { left: 15 * u, top: 12 * u, width: 19 * u, height: 6 * u, borderRadius: 1.5 * u }]} />
      <View style={[styles.bar, { left: 15 * u, top: 21 * u, width: 14 * u, height: 6 * u, borderRadius: 1.5 * u }]} />
      <View
        style={{
          position: 'absolute',
          left: 30.5 * u,
          top: 30.5 * u,
          width: 6 * u,
          height: 6 * u,
          borderRadius: 3 * u,
          backgroundColor: colors.gold,
        }}
      />
    </View>
  );
}

export function FunpayWordmark({
  size = 22,
  color = colors.brand,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Text
      style={{ fontFamily: fonts.sansBold, fontSize: size, letterSpacing: -0.01 * size, color }}
      accessibilityLabel="Funpay"
    >
      Funpay
    </Text>
  );
}

export function FunpayLogo({ markSize = 40, textSize = 24 }: { markSize?: number; textSize?: number }) {
  return (
    <View style={styles.row}>
      <FunpayMark size={markSize} />
      <FunpayWordmark size={textSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', backgroundColor: '#ffffff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
