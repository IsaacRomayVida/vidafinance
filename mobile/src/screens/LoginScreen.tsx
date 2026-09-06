import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { Field } from '../components/Field';
import { FunpayMark, FunpayWordmark } from '../components/FunpayLogo';
import { Backdrop, GlassCard } from '../components/Glass';
import { LoginVideoBackdrop } from '../components/LoginVideoBackdrop';
import { FadeSlideIn, useReducedMotion } from '../components/motion';
import { GhostButton, PrimaryButton } from '../components/PrimaryButton';
import { friendlyError } from '../lib/errors';
import { auth } from '../lib/firebase';
import { EMAIL_REGEX } from '../lib/validation';
import { colors, fonts, spacing } from '../theme';
import type { AuthStackParamList } from '../types';

export function LoginScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Navigation flips via the auth listener in App.tsx; nothing to do here.
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  const resetPassword = async () => {
    setError('');
    setNotice('');
    if (!EMAIL_REGEX.test(email.trim())) {
      setError(t('login.resetNeedsEmail'));
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setNotice(t('login.resetSent'));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const reduced = useReducedMotion();

  return (
    <Backdrop>
      {/* The freedom loop — atmosphere only; static gradient under reduced
          motion or while the first frame loads. */}
      {!reduced ? <LoginVideoBackdrop /> : null}
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FadeSlideIn index={0}>
          <View style={styles.brandBlock}>
            <FunpayMark size={60} />
            <FunpayWordmark size={27} />
          </View>
          <Text style={styles.subtitle}>{t('login.subtitle')}</Text>
        </FadeSlideIn>

        <FadeSlideIn index={1}>
          <GlassCard>
            <View style={styles.form}>
              <Field
                label={t('login.email')}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                editable={!submitting}
                testID="login-email"
                containerStyle={{ marginBottom: spacing.l }}
              />
              <Field
                label={t('login.password')}
                value={password}
                onChangeText={setPassword}
                secure
                autoComplete="password"
                editable={!submitting}
                testID="login-password"
              />

              <GhostButton
                label={t('login.forgot')}
                onPress={() => void resetPassword()}
                style={styles.forgot}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}

              <PrimaryButton
                label={t('login.submit')}
                onPress={() => void submit()}
                busy={submitting}
                style={{ marginTop: spacing.m }}
                testID="login-submit"
              />
            </View>
          </GlassCard>
        </FadeSlideIn>

        <FadeSlideIn index={2}>
          <View style={styles.createRow}>
            <Text style={styles.hint}>{t('login.noAccount')}</Text>
            <GhostButton
              label={t('login.createAccount')}
              onPress={() => navigation.navigate('Onboarding')}
              testID="login-create-account"
            />
          </View>
        </FadeSlideIn>
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
  forgot: { alignSelf: 'flex-end' },
  error: { fontFamily: fonts.sans, color: colors.danger, marginTop: spacing.s, lineHeight: 19 },
  notice: { fontFamily: fonts.sans, color: colors.brandLight, marginTop: spacing.s, lineHeight: 19 },
  createRow: { alignItems: 'center', marginTop: spacing.l },
  hint: {
    fontFamily: fonts.sans,
    color: colors.faint,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
});
