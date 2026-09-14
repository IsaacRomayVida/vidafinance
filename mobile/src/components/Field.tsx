/**
 * The form field: a Doto label over a paper pill (#e9ebe1, no border). Focus
 * lifts the pill to white; an error paints a single hairline in danger and
 * says why beneath. One component so login and onboarding share bones.
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

import { colors, dotLabel, fonts, radii, spacing } from '../theme';
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
  error?: string;
  help?: string;
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
          selectionColor={colors.ink}
          placeholderTextColor={colors.mute}
        />
        {secure ? (
          <PressableScale
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'ocultar contraseña' : 'mostrar contraseña'}
            style={styles.eye}
            hitSlop={10}
          >
            <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.inkSoft} />
          </PressableScale>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...dotLabel, marginBottom: spacing.s },
  input: {
    backgroundColor: colors.paper,
    borderRadius: radii.s,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 18,
    paddingVertical: 14,
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.ink,
    minHeight: 52,
  },
  inputWithEye: { paddingRight: 48 },
  inputFocused: { backgroundColor: '#ffffff' },
  inputError: { borderColor: colors.danger },
  eye: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 48, alignItems: 'center', justifyContent: 'center' },
  error: { fontFamily: fonts.sans, color: colors.danger, fontSize: 13, marginTop: spacing.s, lineHeight: 18 },
  help: { fontFamily: fonts.sans, color: colors.inkSoft, fontSize: 13, marginTop: spacing.s, lineHeight: 18 },
});
