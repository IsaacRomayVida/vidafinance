/**
 * Desktop-web chrome: a cream bar with the mark and the Doto brand label,
 * and a column that keeps content at a readable width. Transparent on phones.
 */
import Constants from 'expo-constants';
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useLayout } from '../lib/layout';
import { colors, fonts, spacing } from '../theme';
import { FunpayLogo } from './FunpayLogo';

export function PageColumn({
  children,
  maxWidth = 720,
  style,
}: {
  children: React.ReactNode;
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { isDesktop } = useLayout();
  if (!isDesktop) return <View style={style}>{children}</View>;
  return <View style={[{ width: '100%', maxWidth, alignSelf: 'center' }, style]}>{children}</View>;
}

export function WebTopBar() {
  return (
    <View style={styles.bar}>
      <View style={styles.barInner}>
        <FunpayLogo markSize={28} textSize={14} />
        <Text style={styles.meta}>Entorno de prueba · v{Constants.expoConfig?.version ?? '?'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.cream, borderBottomWidth: 1, borderBottomColor: colors.hairline },
  barInner: {
    width: '100%',
    maxWidth: 1120,
    alignSelf: 'center',
    paddingHorizontal: spacing.l,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  meta: { fontFamily: fonts.sans, fontSize: 12, color: colors.mute },
});
