/**
 * Onboarding progress: one slim segment per step — done in ink, the current
 * one in the screen's green (it is the active state, the one place green is
 * allowed), the rest paper. Announced as "paso N de M".
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radii, spacing } from '../theme';

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <View
      style={styles.row}
      accessibilityRole="progressbar"
      accessibilityLabel={`paso ${current + 1} de ${total}`}
      accessibilityValue={{ min: 0, max: total, now: current + 1 }}
    >
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.segment, i < current && styles.done, i === current && styles.active]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.s },
  segment: { flex: 1, height: 4, borderRadius: radii.pill, backgroundColor: colors.paper },
  done: { backgroundColor: colors.ink },
  active: { backgroundColor: colors.cta },
});
