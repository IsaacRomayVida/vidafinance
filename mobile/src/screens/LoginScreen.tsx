import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
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
import { useLayout } from '../lib/layout';
import { EMAIL_REGEX } from '../lib/validation';
import { colors, fonts, spacing, type } from '../theme';
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
  const reduced = useReducedMotion();
  const { isDesktop } = useLayout();

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

  const form = (
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
  );

  const createRow = (
    <View style={styles.createRow}>
      <Text style={styles.hint}>{t('login.noAccount')}</Text>
      <GhostButton
        label={t('login.createAccount')}
        onPress={() => navigation.navigate('Onboarding')}
        testID="login-create-account"
      />
      {/* Which build am I holding? — the question every QA round asked. */}
      <Text style={styles.version}>v{Constants.expoConfig?.version ?? '?'}</Text>
    </View>
  );

  if (isDesktop) {
    // Desktop web: split screen. The freedom film owns the left half as a
    // hero; the form sits alone on the right, the way a site signs you in.
    return (
      <Backdrop>
        <View style={styles.split}>
          <View style={styles.heroPane}>
            {!reduced ? <LoginVideoBackdrop variant="hero" /> : null}
            <View style={styles.heroContent}>
              <View style={styles.heroBrand}>
                <FunpayMark size={44} />
                <FunpayWordmark size={22} color="#ffffff" />
              </View>
              <View>
                <Text style={styles.heroTitle}>{t('login.heroTitle')}</Text>
                <Text style={styles.heroBody}>{t('login.heroBody')}</Text>
              </View>
            </View>
          </View>
          <View style={styles.formPane}>
            <View style={styles.formCol}>
              <FadeSlideIn index={0}>
                <Text style={styles.welcome}>{t('login.welcome')}</Text>
                <Text style={[styles.subtitle, { textAlign: 'left' }]}>{t('login.subtitle')}</Text>
              </FadeSlideIn>
              <FadeSlideIn index={1}>{form}</FadeSlideIn>
              <FadeSlideIn index={2}>{createRow}</FadeSlideIn>
            </View>
          </View>
        </View>
      </Backdrop>
    );
  }

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

        <FadeSlideIn index={1}>{form}</FadeSlideIn>
        <FadeSlideIn index={2}>{createRow}</FadeSlideIn>
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
  version: {
    fontFamily: fonts.sans,
    color: colors.faint,
    fontSize: 11,
    marginTop: spacing.m,
  },

  // Desktop split
  split: { flex: 1, flexDirection: 'row' },
  heroPane: { flex: 1.1, backgroundColor: colors.brand, overflow: 'hidden' },
  heroContent: {
    flex: 1,
    justifyContent: 'space-between',
    padding: spacing.xl + spacing.m,
  },
  heroBrand: { flexDirection: 'row', alignItems: 'center', gap: spacing.m },
  heroTitle: {
    fontFamily: fonts.display,
    fontSize: 46,
    lineHeight: 52,
    color: '#ffffff',
    letterSpacing: -0.9,
    maxWidth: 520,
  },
  heroBody: {
    fontFamily: fonts.sans,
    fontSize: 17,
    lineHeight: 26,
    color: 'rgba(255,255,255,0.86)',
    marginTop: spacing.m,
    maxWidth: 480,
  },
  formPane: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  formCol: { width: '100%', maxWidth: 440 },
  welcome: {
    fontFamily: fonts.display,
    fontSize: type.display,
    color: colors.text,
    letterSpacing: -0.64,
  },
});
