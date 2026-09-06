import { LinearGradient } from 'expo-linear-gradient';
import { signInWithEmailAndPassword } from 'firebase/auth';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { FunpayMark, FunpayWordmark } from '../components/FunpayLogo';
import { Backdrop, GlassCard } from '../components/Glass';
import { friendlyError } from '../lib/errors';
import { auth } from '../lib/firebase';
import { colors, fonts, gradient, microLabel, radii, spacing } from '../theme';

// v1 is sign-in only, on purpose: account creation runs through the web
// onboarding (identity verification via MetaMap has no Expo Go path — it
// needs a native module and a dev-client build, tracked for v2). The copy
// points new borrowers at funpay.mx instead of dead-ending them.
export function LoginScreen() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);

  const submit = async () => {
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Navigation flips via the auth listener in App.tsx; nothing to do here.
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  return (
    <Backdrop>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.brandBlock}>
          <FunpayMark size={60} />
          <FunpayWordmark size={27} />
        </View>
        <Text style={styles.subtitle}>{t('login.subtitle')}</Text>

        <GlassCard>
          <View style={styles.form}>
            <Text style={styles.label}>{t('login.email')}</Text>
            <TextInput
              style={[styles.input, focused === 'email' && styles.inputFocused]}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused(null)}
              editable={!submitting}
              selectionColor={colors.brandLight}
              testID="login-email"
            />

            <Text style={[styles.label, { marginTop: spacing.l }]}>{t('login.password')}</Text>
            <TextInput
              style={[styles.input, focused === 'password' && styles.inputFocused]}
              secureTextEntry
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              editable={!submitting}
              selectionColor={colors.brandLight}
              testID="login-password"
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable onPress={submit} disabled={submitting} testID="login-submit">
              <LinearGradient
                colors={gradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.button, submitting && styles.buttonDisabled]}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.onBrand} />
                ) : (
                  <Text style={styles.buttonText}>{t('login.submit')}</Text>
                )}
              </LinearGradient>
            </Pressable>
          </View>
        </GlassCard>

        <Text style={styles.hint}>{t('login.noAccount')}</Text>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.l, justifyContent: 'center' },
  brandBlock: { alignItems: 'center', gap: spacing.m },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.subtle,
    textAlign: 'center',
    marginTop: spacing.m,
    marginBottom: spacing.l,
  },
  form: { padding: spacing.l },
  label: { ...microLabel, marginBottom: spacing.s },
  // A lighter glass within the glass: near-opaque white field so the text
  // stays crisp, with a brand ring on focus.
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
  },
  inputFocused: { borderColor: colors.brandLight },
  error: { fontFamily: fonts.sans, color: colors.danger, marginTop: spacing.m },
  button: {
    borderRadius: radii.pill,
    padding: spacing.m + 2,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 16 },
  hint: {
    fontFamily: fonts.sans,
    color: colors.faint,
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.l,
    lineHeight: 19,
  },
});
