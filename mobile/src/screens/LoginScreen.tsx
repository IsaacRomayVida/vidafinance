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

import { friendlyError } from '../lib/errors';
import { auth } from '../lib/firebase';
import { colors, spacing } from '../theme';

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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.brand}>{t('common.appName')}</Text>
      <Text style={styles.subtitle}>{t('login.subtitle')}</Text>

      <Text style={styles.label}>{t('login.email')}</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        editable={!submitting}
        testID="login-email"
      />

      <Text style={styles.label}>{t('login.password')}</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        autoComplete="password"
        value={password}
        onChangeText={setPassword}
        editable={!submitting}
        testID="login-password"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, submitting && styles.buttonDisabled]}
        onPress={submit}
        disabled={submitting}
        testID="login-submit"
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryText} />
        ) : (
          <Text style={styles.buttonText}>{t('login.submit')}</Text>
        )}
      </Pressable>

      <Text style={styles.hint}>{t('login.noAccount')}</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.l, justifyContent: 'center' },
  brand: { fontSize: 32, fontWeight: '700', color: colors.primary, textAlign: 'center' },
  subtitle: {
    fontSize: 15,
    color: colors.subtle,
    textAlign: 'center',
    marginBottom: spacing.xl,
    marginTop: spacing.xs,
  },
  label: { fontSize: 14, color: colors.text, marginBottom: spacing.xs, marginTop: spacing.m },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.m,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.danger, marginTop: spacing.m },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.primaryText, fontSize: 16, fontWeight: '600' },
  hint: { color: colors.subtle, fontSize: 13, textAlign: 'center', marginTop: spacing.l },
});
