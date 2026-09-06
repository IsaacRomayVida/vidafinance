/**
 * The one CTA of the design language: a deep brand-gradient pill with press
 * scale, a busy spinner, and a disabled state that dims without moving.
 * Every screen used to hand-roll this Pressable+LinearGradient pair; this is
 * that pattern extracted so the eight call sites stay identical.
 */
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, fonts, gradient, radii, spacing } from '../theme';
import { PressableScale } from './motion';

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const blocked = disabled || busy;
  return (
    <PressableScale
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy }}
      testID={testID}
      style={style}
    >
      <LinearGradient
        colors={gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.button, blocked && styles.dimmed]}
      >
        {busy ? (
          <ActivityIndicator color={colors.onBrand} />
        ) : (
          <Text style={styles.label}>{label}</Text>
        )}
      </LinearGradient>
    </PressableScale>
  );
}

/** Quiet sibling: a frosted pill for secondary actions beside the hero CTA. */
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
    paddingVertical: spacing.m + 2,
    paddingHorizontal: spacing.l,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  dimmed: { opacity: 0.55 },
  label: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 16 },
  ghost: {
    fontFamily: fonts.sansBold,
    color: colors.brandLight,
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: spacing.m,
    minHeight: 44,
  },
});
