/**
 * Small shared pieces of the funpay-ui language: the Doto label, the
 * identity avatar, the filter/tag pill, and the paper card. Every screen
 * composes these instead of restating the recipes.
 */
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { colors, dotLabel, fonts, identGradient, radii, shadowFloat, spacing } from '../theme';
import { PressableScale } from './motion';

/** Screen names, the brand, a payroll date. Nothing else. */
export function DotLabel({
  children,
  color = colors.mute,
  size = 13,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  size?: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text numberOfLines={1} style={[dotLabel, { color, fontSize: size, letterSpacing: size * 0.06 }, style]}>
      {children}
    </Text>
  );
}

/** 34px identity circle on the acetate gradient — initials, never a photo. */
export function Avatar({ initials, size = 34 }: { initials: string; size?: number }) {
  return (
    <LinearGradient
      colors={identGradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontFamily: fonts.sansBold, fontSize: size * 0.35, color: '#25352a' }}>{initials}</Text>
    </LinearGradient>
  );
}

export function initialsOf(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** Filter chip: frosted (or paper on cream); the active one goes solid white
 *  with the count in a mint bubble — the only contrast jump on the screen. */
export function Pill({
  label,
  active = false,
  count,
  onPress,
  onLeaf = false,
  testID,
}: {
  label: string;
  active?: boolean;
  count?: number;
  onPress?: () => void;
  /** On the painted leaf board the idle chip is frosted white on green. */
  onLeaf?: boolean;
  testID?: string;
}) {
  const idleBg = onLeaf ? colors.glassLight : colors.paper;
  const idleFg = onLeaf ? 'rgba(255,255,255,0.8)' : colors.inkSoft;
  return (
    <PressableScale
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected: active }}
      testID={testID}
      style={[
        styles.pill,
        { backgroundColor: active ? '#ffffff' : idleBg },
        active && typeof count === 'number' && { paddingLeft: 10 },
        active && shadowFloat,
      ]}
    >
      {active && typeof count === 'number' ? (
        <View style={styles.count}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      ) : null}
      <Text style={[styles.pillText, { color: active ? colors.ink : idleFg }]}>{label}</Text>
    </PressableScale>
  );
}

/** Paper pane: the flat #e9ebe1 surface the skill uses for steps and inputs. */
export function PaperCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.paper, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radii.pill,
  },
  pillText: { fontFamily: fonts.sans, fontSize: 15 },
  count: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.mark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontFamily: fonts.sansBold, fontSize: 12, color: colors.markInk },
  paper: { backgroundColor: colors.paper, borderRadius: radii.m, padding: spacing.m },
});
