/**
 * Entrar — a paper board. The statement headline (ink line, quiet line),
 * then the form, then the one green pill. On desktop web the leaf board
 * takes the left half with the statement in cream and the identity card
 * floating over it; the form sits alone on the right.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { Field } from '../components/Field';
import { FunpayMark } from '../components/FunpayLogo';
import { Backdrop } from '../components/Glass';
import { FadeSlideIn } from '../components/motion';
import { GhostButton, PrimaryButton } from '../components/PrimaryButton';
import { DotLabel } from '../components/Ui';
import { friendlyError } from '../lib/errors';
import { auth } from '../lib/firebase';
import { useLayout } from '../lib/layout';
import { EMAIL_REGEX } from '../lib/validation';
import { colors, fonts, identGradient, radii, shadowFloat, spacing, type } from '../theme';
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
    <View>
      <Field
        label={t('login.email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        editable={!submitting}
        testID="login-email"
        containerStyle={{ marginBottom: spacing.m }}
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
      <GhostButton label={t('login.forgot')} onPress={() => void resetPassword()} style={styles.forgot} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <PrimaryButton label={t('login.submit')} onPress={() => void submit()} busy={submitting} testID="login-submit" />
      <View style={styles.createRow}>
        <Text style={styles.hint}>{t('login.noAccount')}</Text>
        <GhostButton label={t('login.createAccount')} onPress={() => navigation.navigate('Onboarding')} testID="login-create-account" />
        {/* Which build am I holding? — the question every QA round asked. */}
        <Text style={styles.version}>v{Constants.expoConfig?.version ?? '?'}</Text>
      </View>
    </View>
  );

  const statement = (onLeaf: boolean) => (
    <Text style={[styles.title, onLeaf && styles.titleOnLeaf]}>
      {t('login.title')}
      {'\n'}
      <Text style={[styles.titleQuiet, onLeaf && { color: 'rgba(244,247,238,0.7)' }]}>{t('login.titleQuiet')}</Text>
    </Text>
  );

  if (isDesktop) {
    return (
      <View style={styles.split}>
        <View style={{ flex: 1.1 }}>
          <Backdrop variant="leaf">
            <View style={styles.heroContent}>
              <View style={styles.heroHead}>
                <FunpayMark size={40} tone="cream" />
                <DotLabel color="rgba(244,247,238,0.75)" size={14}>FunPay</DotLabel>
              </View>
              <View>
                {statement(true)}
                <Text style={styles.heroBody}>{t('login.statement')}</Text>
              </View>
              <LinearGradient colors={identGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.ident}>
                {[
                  ['MH', t('login.identEmployee')],
                  ['NÓ', t('login.identPayroll')],
                  ['AC', t('login.identLender')],
                ].map(([a, l]) => (
                  <View key={l} style={styles.identRow}>
                    <View style={styles.identDot}>
                      <Text style={styles.identDotText}>{a}</Text>
                    </View>
                    <Text style={styles.identText}>{l}</Text>
                  </View>
                ))}
              </LinearGradient>
            </View>
          </Backdrop>
        </View>
        <View style={styles.formPane}>
          <View style={styles.formCol}>
            <FadeSlideIn index={0}>
              <DotLabel size={14} style={{ marginBottom: spacing.l }}>{t('login.label')}</DotLabel>
            </FadeSlideIn>
            <FadeSlideIn index={1}>{form}</FadeSlideIn>
          </View>
        </View>
      </View>
    );
  }

  return (
    <Backdrop variant="paper">
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FadeSlideIn index={0}>
          <View style={styles.head}>
            <DotLabel size={14}>{t('login.label')}</DotLabel>
            <FunpayMark size={34} />
          </View>
        </FadeSlideIn>
        <View style={{ flex: 1, minHeight: spacing.xl }} />
        <FadeSlideIn index={1}>{statement(false)}</FadeSlideIn>
        <FadeSlideIn index={2} style={{ marginTop: spacing.l }}>
          {form}
        </FadeSlideIn>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 28, paddingTop: 56, paddingBottom: 28 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontFamily: fonts.display, fontSize: type.display, lineHeight: 44, color: colors.ink, letterSpacing: -0.4, maxWidth: 360 },
  titleQuiet: { fontFamily: fonts.sansLight, color: colors.typeQuiet },
  titleOnLeaf: { color: '#f4f7ee', fontSize: 46, lineHeight: 52, maxWidth: 520, textShadowColor: 'rgba(20,40,10,0.4)', textShadowRadius: 18 },
  forgot: { alignSelf: 'flex-end', marginTop: 2 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.s, lineHeight: 19 },
  notice: { fontFamily: fonts.sans, color: colors.markInk, marginBottom: spacing.s, lineHeight: 19 },
  createRow: { alignItems: 'center', marginTop: spacing.m },
  hint: { fontFamily: fonts.sans, color: colors.inkSoft, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  version: { fontFamily: fonts.sans, color: colors.mute, fontSize: 11, marginTop: spacing.s },
  // desktop
  split: { flex: 1, flexDirection: 'row', backgroundColor: colors.cream },
  heroContent: { flex: 1, justifyContent: 'space-between', padding: spacing.xl + spacing.m },
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.m },
  heroBody: { fontFamily: fonts.sansLight, fontSize: 17, lineHeight: 26, color: 'rgba(244,247,238,0.86)', marginTop: spacing.m, maxWidth: 440 },
  ident: { width: 200, padding: 14, paddingHorizontal: 16, borderRadius: radii.s, gap: 10, alignSelf: 'flex-end', transform: [{ rotate: '5deg' }], ...shadowFloat },
  identRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  identDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center' },
  identDotText: { fontFamily: fonts.sansBold, fontSize: 10, color: '#22322a' },
  identText: { fontFamily: fonts.sansBold, fontSize: 13, color: '#22322a' },
  formPane: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  formCol: { width: '100%', maxWidth: 420 },
});
