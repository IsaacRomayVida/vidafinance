/**
 * Desktop-web chrome. On a wide browser the phone canvas would stretch
 * edge to edge; these keep every screen in a readable column and give the
 * signed-in app a site-style top bar. Both are transparent on phones.
 */
import Constants from 'expo-constants';
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useLayout } from '../lib/layout';
import { colors, fonts, spacing } from '../theme';
import { FunpayMark, FunpayWordmark } from './FunpayLogo';

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
        <View style={styles.brand}>
          <FunpayMark size={28} />
          <FunpayWordmark size={18} />
        </View>
        <Text style={styles.meta}>Entorno de prueba · v{Constants.expoConfig?.version ?? '?'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.glassStrong,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
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
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  meta: { fontFamily: fonts.sans, fontSize: 12, color: colors.faint },
});
