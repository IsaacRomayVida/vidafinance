/**
 * Screen header: a paper back circle on the left, the screen's Doto name in
 * the middle. Screen names are labels — never sentences.
 */
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { DotLabel } from './Ui';

export function GlassHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const navigation = useNavigation();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => navigation.goBack()}
        accessibilityRole="button"
        accessibilityLabel="regresar"
        style={[styles.back, { minWidth: 42 }]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.ink} />
      </Pressable>
      <DotLabel size={14} style={{ flex: 1, textAlign: 'center' }}>{title}</DotLabel>
      <View style={styles.spacer}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.l,
    paddingVertical: spacing.m,
  },
  back: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer: { minWidth: 42, alignItems: 'flex-end' },
});
