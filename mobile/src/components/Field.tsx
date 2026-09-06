/**
 * The form field of the design language: uppercase micro-label, a near-opaque
 * white input floating on glass, a brand focus ring, inline error line, and
 * an optional show/hide eye for passwords. One component so every form in the
 * app (login, onboarding) shares identical bones and states.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, microLabel, radii, spacing } from '../theme';
import { PressableScale } from './motion';

export function Field({
  label,
  error,
  help,
  secure = false,
  containerStyle,
  ...input
}: TextInputProps & {
  label: string;
  /** Inline error under the field; also paints the border. */
  error?: string;
  /** Quiet helper line, shown when there is no error. */
  help?: string;
  /** Password mode: masks input and adds the show/hide toggle. */
  secure?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={containerStyle}>
      <Text style={styles.label}>{label}</Text>
      <View>
        <TextInput
          {...input}
          secureTextEntry={secure && !revealed}
          style={[
            styles.input,
            secure && styles.inputWithEye,
            focused && styles.inputFocused,
            !!error && styles.inputError,
            input.style,
          ]}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          selectionColor={colors.brandLight}
          placeholderTextColor={colors.faint}
        />
        {secure ? (
          <PressableScale
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'ocultar contraseña' : 'mostrar contraseña'}
            style={styles.eye}
            hitSlop={10}
          >
            <Ionicons
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={colors.subtle}
            />
          </PressableScale>
        ) : null}
      </View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : help ? (
        <Text style={styles.help}>{help}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...microLabel, marginBottom: spacing.s },
  input: {
    backgroundColor: colors.glassStrong,
    borderRadius: radii.m,
    borderWidth: 1.5,
    borderColor: colors.glassBorder,
    paddingHorizontal: spacing.m,
    paddingVertical: 13,
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.text,
    minHeight: 50,
  },
  inputWithEye: { paddingRight: 46 },
  inputFocused: { borderColor: colors.brandLight },
  inputError: { borderColor: colors.danger },
  eye: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    fontFamily: fonts.sans,
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.s,
    lineHeight: 18,
  },
  help: {
    fontFamily: fonts.sans,
    color: colors.faint,
    fontSize: 13,
    marginTop: spacing.s,
    lineHeight: 18,
  },
});
