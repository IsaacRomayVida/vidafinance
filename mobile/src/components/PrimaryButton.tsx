/**
 * The pills. `PrimaryButton` is the ONE saturated control a screen gets —
 * flat --cta green, ink type, no gradient, no shadow. `variant="ink"` is
 * the dark pill (cream type) for a screen whose green is already spent.
 * `GhostButton` is plain ink text.
 */
import * as Haptics from 'expo-haptics';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fonts, radii, spacing } from '../theme';
import { PressableScale } from './motion';

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  variant = 'cta',
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'cta' | 'ink';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const blocked = disabled || busy;
  const ink = variant === 'ink';
  return (
    <PressableScale
      onPress={() => {
        // Medium, not Light: mid-range Android motors (Galaxy A-series) render
        // Light as imperceptible; Medium reads as a tap on both platforms.
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy }}
      testID={testID}
      style={style}
    >
      <View style={[styles.button, ink && styles.ink, blocked && styles.dimmed]}>
        {busy ? (
          <ActivityIndicator color={ink ? colors.cream : colors.ink} />
        ) : (
          <Text style={[styles.label, ink && styles.labelInk]}>{label}</Text>
        )}
      </View>
    </PressableScale>
  );
}

export function GhostButton({
  label,
  onPress,
  disabled = false,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      style={style}
    >
      <Text style={[styles.ghost, disabled && styles.dimmed]}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.l,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
    backgroundColor: colors.cta,
  },
  ink: { backgroundColor: colors.ink },
  dimmed: { opacity: 0.45 },
  label: { fontFamily: fonts.sansBold, color: colors.ink, fontSize: 16 },
  labelInk: { color: colors.cream },
  ghost: {
    fontFamily: fonts.sansMedium,
    color: colors.ink,
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: spacing.m,
    minHeight: 44,
  },
});
