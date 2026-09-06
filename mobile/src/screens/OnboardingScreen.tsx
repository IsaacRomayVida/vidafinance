/**
 * Employee registration — the web onboarding's employee branch, rebuilt for
 * one hand and one question at a time. Six steps: employer code → personal
 * data → identity (MetaMap) → employment + bank → password → done.
 *
 * Contract notes that matter here:
 *  - The payload rules live in lib/registration.ts (tested); this screen
 *    only collects.
 *  - Identity runs native (real builds) or via the web widget in a WebView
 *    (Expo Go); either lands verificationId/identityId. "Verificar después"
 *    keeps signup unblocked when a device can't run the widget — the server
 *    refuses money to unverified borrowers regardless (IDENTITY_NOT_VERIFIED),
 *    so this is UX, not a security decision.
 *  - After the account exists, App.tsx would normally flip to the signed-in
 *    stack instantly; the onboardingHold context keeps the success moment on
 *    screen until the borrower taps through.
 */
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { checkEmailAvailability, lookupEmployerByCode } from '../api/callables';
import { CountUpMxn } from '../components/CountUp';
import { Field } from '../components/Field';
import { Backdrop, GlassCard } from '../components/Glass';
import { KycWebView, type KycResult } from '../components/KycWebView';
import { FadeSlideIn, PressableScale } from '../components/motion';
import { GhostButton, PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { StepDots } from '../components/StepDots';
import { useOnboardingHold } from '../hooks/useAuth';
import { friendlyError } from '../lib/errors';
import { auth, db } from '../lib/firebase';
import { launchNativeKyc, nativeKycAvailable } from '../lib/kyc';
import { formatMxn } from '../lib/money';
import { registerEmployee } from '../lib/registration';
import {
  ageEligible,
  curpValid,
  EMAIL_REGEX,
  EMPLOYMENT_TENURES,
  formatDobInput,
  formatSalaryInput,
  normalizeCurp,
  normalizeEmployerCode,
  normalizePhone,
  parseSalary,
  PAY_FREQUENCIES,
  phoneValid,
  previewCreditLine,
  validateClabe,
  type EmploymentTenure,
  type PayFrequency,
} from '../lib/validation';
import { colors, fonts, microLabel, radii, spacing, type } from '../theme';
import type { AuthStackParamList } from '../types';

type CodeStatus = 'idle' | 'searching' | 'found' | 'not_found';
type EmailStatus = 'idle' | 'checking' | 'available' | 'taken';
type KycState = 'not_started' | 'running' | 'pending_review';

const TOTAL_STEPS = 5; // form steps; the success screen sits outside the dots

export function OnboardingScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Onboarding'>;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { setHold } = useOnboardingHold();

  const [step, setStep] = useState(0);

  // Step 0 — employer code
  const [code, setCode] = useState('');
  const [codeStatus, setCodeStatus] = useState<CodeStatus>('idle');
  const [employerId, setEmployerId] = useState('');
  const [employerName, setEmployerName] = useState('');

  // Step 1 — personal
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<EmailStatus>('idle');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [curp, setCurp] = useState('');

  // Step 2 — identity
  const [kycState, setKycState] = useState<KycState>('not_started');
  const [kycIds, setKycIds] = useState<KycResult>({ verificationId: '', identityId: '' });
  const [showWebKyc, setShowWebKyc] = useState(false);

  // Step 3 — employment + bank
  const [salaryText, setSalaryText] = useState('');
  const [frequency, setFrequency] = useState<PayFrequency | null>(null);
  const [tenure, setTenure] = useState<EmploymentTenure | null>(null);
  const [clabe, setClabe] = useState('');

  // Step 4 — password + terms
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // While the wizard lives, a created auth user must not flip the app to the
  // signed-in stack — the success screen still owes the borrower a moment.
  useEffect(() => {
    setHold(true);
    return () => setHold(false);
  }, [setHold]);

  // Employer-code lookup: 500ms debounce, skipped below 4 chars, any throw
  // reads as not-found (same collapse the web makes).
  useEffect(() => {
    if (code.length < 4) {
      setCodeStatus('idle');
      return;
    }
    setCodeStatus('searching');
    const timer = setTimeout(() => {
      lookupEmployerByCode(code)
        .then((result) => {
          if (result.found && result.employerId) {
            setEmployerId(result.employerId);
            setEmployerName(result.companyName ?? '');
            setCodeStatus('found');
          } else {
            setCodeStatus('not_found');
          }
        })
        .catch(() => setCodeStatus('not_found'));
    }, 500);
    return () => clearTimeout(timer);
  }, [code]);

  // Email availability: 800ms debounce, only for well-formed emails,
  // fail-open (the callable wrapper already reports available on error).
  useEffect(() => {
    if (!EMAIL_REGEX.test(email)) {
      setEmailStatus('idle');
      return;
    }
    setEmailStatus('checking');
    const timer = setTimeout(() => {
      checkEmailAvailability(email).then((available) =>
        setEmailStatus(available ? 'available' : 'taken')
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [email]);

  const salary = parseSalary(salaryText);
  const preview = previewCreditLine(salary);

  const ageOk = ageEligible(dob);
  const curpOk = curpValid(curp);
  const canProceed = useMemo(() => {
    switch (step) {
      case 0:
        return codeStatus === 'found';
      case 1:
        return (
          name.trim().length > 0 &&
          EMAIL_REGEX.test(email) &&
          phoneValid(phone) &&
          ageOk &&
          curpOk &&
          emailStatus !== 'taken' &&
          emailStatus !== 'checking'
        );
      case 2:
        return kycState === 'pending_review';
      case 3:
        return salary > 0 && frequency !== null && tenure !== null && validateClabe(clabe);
      case 4:
        return password.length >= 6 && terms;
      default:
        return false;
    }
  }, [
    step, codeStatus, name, email, phone, ageOk, curpOk, emailStatus,
    kycState, salary, frequency, tenure, clabe, password, terms,
  ]);

  const kycMetadata = useMemo(() => {
    const parts = name.trim().split(' ');
    return {
      curp,
      email,
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
      phone,
    };
  }, [name, email, phone, curp]);

  const startKyc = async () => {
    // Dev-only test bypass, mirroring the web's testBypassAllowed: emulator
    // QA accounts skip the widget. NEVER 'approved' — firestore.rules denies
    // any client-written kycStatus outside not_started|pending_review|rejected.
    if (__DEV__ && email.endsWith('@vida-test.com')) {
      setKycIds({
        verificationId: `test-verification-${Date.now()}`,
        identityId: `test-identity-${Date.now()}`,
      });
      setKycState('pending_review');
      return;
    }
    if (nativeKycAvailable()) {
      setKycState('running');
      try {
        const result = await launchNativeKyc(kycMetadata);
        if (result === 'canceled') {
          setKycState('not_started');
        } else {
          setKycIds(result);
          setKycState('pending_review');
        }
      } catch {
        // Native path broke: fall back to the web widget.
        setShowWebKyc(true);
      }
    } else {
      setKycState('running');
      setShowWebKyc(true);
    }
  };

  const submit = async () => {
    if (creating || !canProceed) return;
    setError('');
    setCreating(true);
    try {
      await registerEmployee(auth, db, {
        name: name.trim(),
        email: email.trim(),
        password,
        phone,
        dateOfBirth: dob,
        curp,
        employerId,
        employerName,
        employerCode: code,
        monthlySalary: salary,
        payFrequency: frequency as PayFrequency,
        employmentTenure: tenure as EmploymentTenure,
        bankClabe: clabe,
        kycStatus: kycIds.verificationId ? 'pending_review' : 'not_started',
        metamapVerificationId: kycIds.verificationId,
        metamapIdentityId: kycIds.identityId,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setDone(true);
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  };

  const goBack = () => {
    setError('');
    if (step === 0) navigation.goBack();
    else setStep((s) => s - 1);
  };

  // ── Success ──────────────────────────────────────────────────────────────
  if (done) {
    return (
      <Backdrop>
        <View style={[styles.center, { paddingTop: insets.top }]}>
          <FadeSlideIn>
            <GlassCard>
              <View style={styles.successInner}>
                <View style={styles.successBadge}>
                  <Text style={styles.successBadgeText}>{t('onboarding.stepDone.badge')}</Text>
                </View>
                <Text style={styles.successTitle}>{t('onboarding.stepDone.title')}</Text>
                <CountUpMxn value={preview} style={styles.successAmount} duration={900} />
                <Text style={styles.subtitleCenter}>{t('onboarding.stepDone.subtitle')}</Text>
                <PrimaryButton
                  label={t('onboarding.stepDone.cta')}
                  onPress={() => setHold(false)}
                  style={{ alignSelf: 'stretch', marginTop: spacing.l }}
                  testID="onb-done"
                />
              </View>
            </GlassCard>
          </FadeSlideIn>
        </View>
      </Backdrop>
    );
  }

  // ── Full-screen web KYC (Expo Go fallback / native-path failure) ─────────
  if (showWebKyc) {
    return (
      <Backdrop>
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <View style={styles.headerRow}>
            <BackButton onPress={() => { setShowWebKyc(false); setKycState('not_started'); }} />
            <Text style={styles.headerTitle}>{t('onboarding.stepKyc.title')}</Text>
            <View style={{ width: 42 }} />
          </View>
          <KycWebView
            metadata={kycMetadata}
            onFinished={(result) => {
              setKycIds(result);
              setKycState('pending_review');
              setShowWebKyc(false);
            }}
            onExited={() => {
              setShowWebKyc(false);
              setKycState('not_started');
            }}
          />
        </View>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ paddingTop: insets.top }}>
          <View style={styles.headerRow}>
            <BackButton onPress={goBack} />
            <View style={styles.dotsWrap}>
              <StepDots total={TOTAL_STEPS} current={step} />
            </View>
            <View style={{ width: 42 }} />
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.l, paddingBottom: spacing.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <FadeSlideIn key={step}>
            {step === 0 ? (
              <StepFrame
                title={t('onboarding.stepCode.title')}
                subtitle={t('onboarding.stepCode.subtitle')}
              >
                <Field
                  label={t('onboarding.stepCode.label')}
                  value={code}
                  onChangeText={(raw) => setCode(normalizeEmployerCode(raw))}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder={t('onboarding.stepCode.placeholder')}
                  maxLength={8}
                  help={t('onboarding.stepCode.hint')}
                  testID="onb-code"
                  style={styles.codeInput}
                />
                {codeStatus !== 'idle' ? (
                  <View style={styles.codeStatusRow}>
                    {codeStatus === 'searching' ? (
                      <>
                        <Skeleton width={16} height={16} radius={8} />
                        <Text style={styles.codeStatusText}>
                          {t('onboarding.stepCode.searching')}
                        </Text>
                      </>
                    ) : codeStatus === 'found' ? (
                      <>
                        <Ionicons name="checkmark-circle" size={18} color={colors.brandLight} />
                        <Text style={[styles.codeStatusText, { color: colors.brandLight }]}>
                          {t('onboarding.stepCode.found')}
                          {employerName ? ` · ${employerName}` : ''}
                        </Text>
                      </>
                    ) : (
                      <>
                        <Ionicons name="close-circle" size={18} color={colors.danger} />
                        <Text style={[styles.codeStatusText, { color: colors.danger }]}>
                          {t('onboarding.stepCode.notFound')}
                        </Text>
                      </>
                    )}
                  </View>
                ) : null}
              </StepFrame>
            ) : step === 1 ? (
              <StepFrame
                title={t('onboarding.stepPersonal.title')}
                subtitle={t('onboarding.stepPersonal.subtitle')}
              >
                <Field
                  label={t('onboarding.stepPersonal.name')}
                  value={name}
                  onChangeText={setName}
                  autoComplete="name"
                  testID="onb-name"
                  containerStyle={styles.fieldGap}
                />
                <Field
                  label={t('onboarding.stepPersonal.email')}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  error={emailStatus === 'taken' ? t('onboarding.stepPersonal.emailTaken') : undefined}
                  help={
                    emailStatus === 'checking'
                      ? t('onboarding.stepPersonal.emailChecking')
                      : emailStatus === 'available'
                        ? t('onboarding.stepPersonal.emailAvailable')
                        : undefined
                  }
                  testID="onb-email"
                  containerStyle={styles.fieldGap}
                />
                <Field
                  label={t('onboarding.stepPersonal.phone')}
                  value={phone}
                  onChangeText={(raw) => setPhone(normalizePhone(raw))}
                  keyboardType="phone-pad"
                  placeholder={t('onboarding.stepPersonal.phonePlaceholder')}
                  testID="onb-phone"
                  containerStyle={styles.fieldGap}
                />
                <Field
                  label={t('onboarding.stepPersonal.dob')}
                  value={dob}
                  onChangeText={(raw) => setDob(formatDobInput(raw))}
                  keyboardType="number-pad"
                  placeholder={t('onboarding.stepPersonal.dobPlaceholder')}
                  maxLength={10}
                  error={
                    dob.length === 10 && !ageOk
                      ? t('onboarding.stepPersonal.ageError')
                      : undefined
                  }
                  testID="onb-dob"
                  containerStyle={styles.fieldGap}
                />
                <Field
                  label={t('onboarding.stepPersonal.curp')}
                  value={curp}
                  onChangeText={(raw) => setCurp(normalizeCurp(raw))}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={18}
                  error={!curpOk ? t('onboarding.stepPersonal.curpError') : undefined}
                  help={curpOk ? t('onboarding.stepPersonal.curpHint') : undefined}
                  testID="onb-curp"
                  containerStyle={styles.fieldGap}
                />
              </StepFrame>
            ) : step === 2 ? (
              <StepFrame
                title={t('onboarding.stepKyc.title')}
                subtitle={t('onboarding.stepKyc.subtitle')}
              >
                <GlassCard>
                  <View style={styles.kycInner}>
                    <View
                      style={[
                        styles.kycIcon,
                        kycState === 'pending_review' && { backgroundColor: colors.aquaTint },
                      ]}
                    >
                      <Ionicons
                        name={kycState === 'pending_review' ? 'shield-checkmark' : 'shield-outline'}
                        size={30}
                        color={kycState === 'pending_review' ? colors.brandLight : colors.gold}
                      />
                    </View>
                    {kycState === 'pending_review' ? (
                      <Text style={styles.kycDone}>{t('onboarding.stepKyc.done')}</Text>
                    ) : (
                      <PrimaryButton
                        label={t('onboarding.stepKyc.start')}
                        onPress={() => void startKyc()}
                        busy={kycState === 'running'}
                        style={{ alignSelf: 'stretch' }}
                        testID="onb-kyc-start"
                      />
                    )}
                    <View style={styles.trustRow}>
                      <Ionicons name="lock-closed-outline" size={13} color={colors.faint} />
                      <Text style={styles.trustText}>{t('onboarding.stepKyc.trust1')}</Text>
                    </View>
                    <View style={styles.trustRow}>
                      <Ionicons name="document-text-outline" size={13} color={colors.faint} />
                      <Text style={styles.trustText}>{t('onboarding.stepKyc.trust2')}</Text>
                    </View>
                  </View>
                </GlassCard>
                {kycState !== 'pending_review' ? (
                  <>
                    <Text style={styles.laterNote}>{t('onboarding.stepKyc.laterNote')}</Text>
                    <GhostButton
                      label={t('onboarding.stepKyc.later')}
                      onPress={() => setStep(3)}
                      testID="onb-kyc-later"
                    />
                  </>
                ) : null}
              </StepFrame>
            ) : step === 3 ? (
              <StepFrame
                title={t('onboarding.stepWork.title')}
                subtitle={t('onboarding.stepWork.subtitle')}
              >
                {salary > 0 ? (
                  <GlassCard style={{ marginBottom: spacing.l }}>
                    <View style={styles.previewInner}>
                      <View style={{ flex: 1 }}>
                        <Text style={microLabel}>{t('onboarding.stepWork.previewLabel')}</Text>
                        <CountUpMxn value={preview} style={styles.previewAmount} />
                        <Text style={styles.trustText}>{t('onboarding.stepWork.previewNote')}</Text>
                      </View>
                      <View style={styles.previewBadge}>
                        <Text style={styles.previewBadgeText}>
                          {t('onboarding.stepWork.previewBadge')}
                        </Text>
                      </View>
                    </View>
                  </GlassCard>
                ) : null}
                <Field
                  label={t('onboarding.stepWork.salary')}
                  value={salaryText}
                  onChangeText={(raw) => setSalaryText(formatSalaryInput(raw))}
                  keyboardType="number-pad"
                  placeholder={t('onboarding.stepWork.salaryPlaceholder')}
                  testID="onb-salary"
                  containerStyle={styles.fieldGap}
                />
                <Text style={[microLabel, styles.groupLabel]}>
                  {t('onboarding.stepWork.frequency')}
                </Text>
                <View style={styles.pillGrid}>
                  {PAY_FREQUENCIES.map((value) => (
                    <SelectPill
                      key={value}
                      label={t(`onboarding.stepWork.${value}`)}
                      active={frequency === value}
                      onPress={() => setFrequency(value)}
                    />
                  ))}
                </View>
                <Text style={[microLabel, styles.groupLabel]}>
                  {t('onboarding.stepWork.tenure')}
                </Text>
                <View style={styles.pillGrid}>
                  {EMPLOYMENT_TENURES.map((value) => (
                    <SelectPill
                      key={value}
                      label={t(`onboarding.stepWork.${tenureKey(value)}`)}
                      active={tenure === value}
                      onPress={() => setTenure(value)}
                    />
                  ))}
                </View>
                <Field
                  label={t('onboarding.stepWork.clabe')}
                  value={clabe}
                  onChangeText={(raw) => setClabe(raw.replace(/\D/g, '').slice(0, 18))}
                  keyboardType="number-pad"
                  placeholder={t('onboarding.stepWork.clabePlaceholder')}
                  maxLength={18}
                  error={
                    clabe.length === 18 && !validateClabe(clabe)
                      ? t('onboarding.stepWork.clabeError')
                      : undefined
                  }
                  help={t('onboarding.stepWork.clabeHint')}
                  testID="onb-clabe"
                  containerStyle={styles.fieldGap}
                />
              </StepFrame>
            ) : (
              <StepFrame
                title={t('onboarding.stepPassword.title')}
                subtitle={t('onboarding.stepPassword.subtitle')}
              >
                <Field
                  label={t('onboarding.stepPassword.password')}
                  value={password}
                  onChangeText={setPassword}
                  secure
                  autoComplete="new-password"
                  placeholder={t('onboarding.stepPassword.passwordPlaceholder')}
                  testID="onb-password"
                  containerStyle={styles.fieldGap}
                />
                <PressableScale
                  onPress={() => setTerms((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: terms }}
                  style={styles.termsRow}
                  testID="onb-terms"
                >
                  <View style={[styles.checkbox, terms && styles.checkboxOn]}>
                    {terms ? <Ionicons name="checkmark" size={14} color={colors.onBrand} /> : null}
                  </View>
                  <Text style={styles.termsText}>{t('onboarding.stepPassword.terms')}</Text>
                </PressableScale>
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </StepFrame>
            )}
          </FadeSlideIn>

          <PrimaryButton
            label={
              step === 4
                ? creating
                  ? t('onboarding.stepPassword.creating')
                  : t('onboarding.stepPassword.submit')
                : t('onboarding.continue')
            }
            onPress={() => {
              if (step === 4) void submit();
              else {
                Haptics.selectionAsync().catch(() => {});
                setStep((s) => s + 1);
              }
            }}
            disabled={!canProceed}
            busy={creating}
            style={{ marginTop: spacing.l }}
            testID="onb-continue"
          />

          <View style={styles.signInRow}>
            <Text style={styles.signInHint}>{t('onboarding.haveAccount')} </Text>
            <GhostButton
              label={t('onboarding.signIn')}
              onPress={() => navigation.navigate('Login')}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}

// ── Small local pieces ─────────────────────────────────────────────────────

function StepFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      {children}
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="regresar"
      style={styles.back}
    >
      <Ionicons name="chevron-back" size={22} color={colors.brand} />
    </PressableScale>
  );
}

function SelectPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.pill, active && styles.pillActive]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </PressableScale>
  );
}

function tenureKey(value: EmploymentTenure): string {
  switch (value) {
    case '<6m':
      return 'tenureLt6m';
    case '6m-1y':
      return 'tenure6m1y';
    case '1-2y':
      return 'tenure12y';
    case '2-5y':
      return 'tenure25y';
    case '5y+':
      return 'tenure5y';
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: spacing.l },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.m,
    paddingHorizontal: spacing.l,
    paddingVertical: spacing.m,
  },
  dotsWrap: { flex: 1 },
  back: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontFamily: fonts.display, fontSize: 20, color: colors.text, flex: 1, textAlign: 'center' },
  title: {
    fontFamily: fonts.display,
    fontSize: type.display,
    color: colors.text,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: type.body,
    color: colors.subtle,
    marginTop: spacing.s,
    marginBottom: spacing.l,
    lineHeight: 22,
  },
  subtitleCenter: {
    fontFamily: fonts.sans,
    fontSize: type.body,
    color: colors.subtle,
    textAlign: 'center',
    lineHeight: 22,
  },
  fieldGap: { marginBottom: spacing.l },
  codeInput: {
    fontFamily: fonts.sansBold,
    fontSize: 24,
    letterSpacing: 6,
    textAlign: 'center',
  },
  codeStatusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s, marginTop: spacing.m },
  codeStatusText: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.subtle },
  kycInner: { padding: spacing.l, alignItems: 'center', gap: spacing.m },
  kycIcon: {
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    backgroundColor: colors.goldTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kycDone: { fontFamily: fonts.sansBold, fontSize: 16, color: colors.brandLight },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trustText: { fontFamily: fonts.sans, fontSize: 12.5, color: colors.faint },
  laterNote: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.faint,
    lineHeight: 19,
    marginTop: spacing.l,
    textAlign: 'center',
  },
  previewInner: { padding: spacing.l, flexDirection: 'row', alignItems: 'center' },
  previewAmount: {
    fontFamily: fonts.sansBold,
    fontSize: 30,
    color: colors.brand,
    letterSpacing: -0.5,
    marginVertical: 4,
    fontVariant: ['tabular-nums'],
  },
  previewBadge: {
    backgroundColor: colors.goldTint,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
  },
  previewBadgeText: { fontFamily: fonts.sansBold, fontSize: 12, color: colors.gold },
  groupLabel: { marginBottom: spacing.s, marginTop: spacing.xs },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s, marginBottom: spacing.l },
  pill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 10,
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    minHeight: 40,
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 13.5, color: colors.subtle },
  pillTextActive: { color: colors.onBrand },
  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.m, paddingVertical: spacing.s },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    backgroundColor: colors.glassStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  termsText: { flex: 1, fontFamily: fonts.sans, fontSize: 13.5, color: colors.subtle, lineHeight: 19 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginTop: spacing.m, lineHeight: 19 },
  signInRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.m,
  },
  signInHint: { fontFamily: fonts.sans, fontSize: 14, color: colors.faint },
  successInner: { padding: spacing.l, alignItems: 'center' },
  successBadge: {
    backgroundColor: colors.goldTint,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
    marginBottom: spacing.m,
  },
  successBadgeText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.8,
    color: colors.gold,
  },
  successTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    color: colors.brand,
    textAlign: 'center',
  },
  successAmount: {
    fontFamily: fonts.sansBold,
    fontSize: 44,
    color: colors.text,
    letterSpacing: -1,
    marginVertical: spacing.m,
    fontVariant: ['tabular-nums'],
  },
});
