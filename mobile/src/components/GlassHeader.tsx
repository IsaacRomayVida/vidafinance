/**
 * The in-screen header for glass screens: a frosted back button and the
 * screen's serif title, floating over the backdrop.
 */
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, spacing } from '../theme';

export function GlassHeader({ title }: { title: string }) {
  const navigation = useNavigation();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => navigation.goBack()}
        accessibilityRole="button"
        accessibilityLabel="back"
        style={styles.backShadow}
      >
        <BlurView intensity={24} tint="light" style={styles.backClip}>
          <View style={styles.backFill}>
            <Ionicons name="chevron-back" size={22} color={colors.brand} />
          </View>
        </BlurView>
      </Pressable>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.spacer} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.m,
    paddingHorizontal: spacing.l,
    paddingTop: spacing.m,
    paddingBottom: spacing.m,
  },
  backShadow: {
    borderRadius: radii.pill,
    shadowColor: colors.brand,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  backClip: { borderRadius: radii.pill, overflow: 'hidden' },
  backFill: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fonts.display, fontSize: 24, color: colors.text, letterSpacing: -0.2 },
  spacer: { width: 42 },
});
