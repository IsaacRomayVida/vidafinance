import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { doc, getDoc } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchLoanConfig, submitLoanRequest, type LoanConfig } from '../api/callables';
import { FunpayMark } from '../components/FunpayLogo';
import { Backdrop, GlassCard } from '../components/Glass';
import { GlassHeader } from '../components/GlassHeader';
import { GoldBurst } from '../components/GoldBurst';
import { FadeSlideIn, PressableScale } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { useAuth } from '../hooks/useAuth';
import { friendlyError } from '../lib/errors';
import { auth, db } from '../lib/firebase';
import { formatMxn, previewTotal } from '../lib/money';
import { colors, fonts, gradient, microLabel, radii, spacing } from '../theme';
import type { RootStackParamList } from '../types';

const MIN_AMOUNT = 500;
const MAX_AMOUNT = 5000;
const QUICK_AMOUNTS = [500, 1000, 2500, 5000];

interface EmployeeDoc {
  employerCode?: string;
  bankClabe?: string;
  [key: string]: unknown;
}

export function RequestLoanScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestLoan'>;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [config, setConfig] = useState<LoanConfig | null>(null);
  const [employee, setEmployee] = useState<EmployeeDoc | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const [amountText, setAmountText] = useState('1000');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successRef, setSuccessRef] = useState<string | null>(null);

  const uid = user?.uid;
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        // Pricing and the borrower's own doc load together here (unlike the
        // web wizard) because BOTH are prerequisites of showing the form at
        // all in this minimal screen; either failing lands on the same retry
        // card. The web app's rule still holds where it matters: without a
        // server-approved rate, no rate is ever rendered and nothing submits.
        const [loanConfig, employeeSnapshot] = await Promise.all([
          fetchLoanConfig(),
          getDoc(doc(db, 'employees', uid)),
        ]);
        if (cancelled) return;
        setConfig(loanConfig);
        setEmployee((employeeSnapshot.data() as EmployeeDoc | undefined) ?? null);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, retryToken]);

  const amount = Number(amountText);
  const amountValid =
    Number.isInteger(amount) && amount >= MIN_AMOUNT && amount <= MAX_AMOUNT && amount % 100 === 0;
  const total = config && amountValid ? previewTotal(amount, config.feeRate) : null;

  const submit = async () => {
    if (submitting || !config || !amountValid) return;
    setError('');
    setSubmitting(true);
    try {
      // Fresh claims before the money call, same as the web wizard.
      if (auth.currentUser) await auth.currentUser.getIdToken(true);
      const result = await submitLoanRequest({
        amount,
        employerCode: employee?.employerCode || '',
        bankAccountClabe: employee?.bankClabe || '',
        termsAccepted: true,
        termDays: typeof config.defaultTermDays === 'number' ? config.defaultTermDays : 30,
      });
      setSuccessRef(result.loanRef || result.loanId);
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  if (status === 'loading') {
    return (
      <Backdrop>
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} size="large" />
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop>
        <View style={styles.center}>
          <Text style={styles.error}>{t('request.priceUnavailable')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
        </View>
      </Backdrop>
    );
  }

  if (successRef) {
    return (
      <Backdrop>
        <View style={styles.center}>
          <GoldBurst />
          <FadeSlideIn>
          <GlassCard>
            <View style={styles.successInner}>
              <FunpayMark size={56} />
              <Text style={styles.successTitle}>{t('request.successTitle')}</Text>
              <Text style={styles.successBody}>{t('request.successBody', { ref: successRef })}</Text>
              <PrimaryButton
                label={t('loans.title')}
                onPress={() => navigation.navigate('Loans')}
                style={{ alignSelf: 'stretch', marginTop: spacing.s }}
              />
            </View>
          </GlassCard>
          </FadeSlideIn>
        </View>
      </Backdrop>
    );
  }

  const feePercent = config ? Math.round(config.feeRate * 1000) / 10 : null;

  return (
    <Backdrop>
      <View style={{ paddingTop: insets.top }}>
        <GlassHeader title={t('request.title')} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={{ padding: spacing.l, paddingTop: spacing.s }}>
        <GlassCard>
          <View style={styles.amountInner}>
            <Text style={styles.label}>{t('request.amountLabel')}</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={amountText}
              onChangeText={setAmountText}
              editable={!submitting}
              selectionColor={colors.brandLight}
              testID="request-amount"
            />
            <View style={styles.quickRow}>
              {QUICK_AMOUNTS.map((quick) => {
                const active = amountText === String(quick);
                return (
                  <PressableScale
                    key={quick}
                    onPress={() => setAmountText(String(quick))}
                    disabled={submitting}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.quickPill, active && styles.quickPillActive]}
                  >
                    <Text style={[styles.quickText, active && styles.quickTextActive]}>
                      {formatMxn(quick)}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>
            <Text style={styles.help}>
              {t('request.amountHelp', { min: formatMxn(MIN_AMOUNT), max: formatMxn(MAX_AMOUNT) })}
            </Text>
          </View>
        </GlassCard>

        {/* Pricing summary on its own glass — the rate the server approved,
            never one computed only client-side (#424). */}
        {feePercent !== null || total !== null ? (
          <GlassCard style={{ marginTop: spacing.m }}>
            <View style={styles.summaryInner}>
              {feePercent !== null ? (
                <Text style={styles.priceLine}>{t('request.feeLine', { feePercent })}</Text>
              ) : null}
              {total !== null ? (
                <>
                  <Text style={styles.priceTotal}>
                    {t('request.totalLine', { total: formatMxn(total) })}
                  </Text>
                  <Text style={styles.help}>{t('request.totalNote')}</Text>
                </>
              ) : null}
            </View>
          </GlassCard>
        ) : null}

        <Text style={styles.terms}>{t('request.terms')}</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <PrimaryButton
          label={t('request.submit')}
          onPress={() => void submit()}
          disabled={!amountValid}
          busy={submitting}
          style={{ marginTop: spacing.l }}
          testID="request-submit"
        />
      </ScrollView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  amountInner: { padding: spacing.l },
  label: { ...microLabel, marginBottom: spacing.s },
  input: {
    fontFamily: fonts.sansBold,
    fontSize: 40,
    letterSpacing: -0.5,
    color: colors.text,
    paddingVertical: spacing.s,
    fontVariant: ['tabular-nums'],
  },
  quickRow: { flexDirection: 'row', gap: spacing.s, marginTop: spacing.s, flexWrap: 'wrap' },
  quickPill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 8,
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  quickPillActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  quickText: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.subtle },
  quickTextActive: { color: colors.onBrand },
  help: { fontFamily: fonts.sans, color: colors.faint, fontSize: 13, marginTop: spacing.m, lineHeight: 19 },
  summaryInner: { padding: spacing.l },
  priceLine: { fontFamily: fonts.sansMedium, color: colors.subtle, fontSize: 15 },
  priceTotal: { fontFamily: fonts.sansBold, color: colors.text, fontSize: 17, marginTop: spacing.s },
  terms: { fontFamily: fonts.sans, color: colors.faint, fontSize: 13, marginTop: spacing.l, lineHeight: 19 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginTop: spacing.m, textAlign: 'center' },
  button: {
    borderRadius: radii.pill,
    padding: spacing.m + 2,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 16 },
  retryButton: { borderRadius: radii.pill, paddingVertical: spacing.m, paddingHorizontal: spacing.xl },
  successInner: { padding: spacing.l, alignItems: 'center' },
  successTitle: {
    fontFamily: fonts.display,
    fontSize: 28,
    color: colors.brand,
    marginTop: spacing.l,
    marginBottom: spacing.m,
    textAlign: 'center',
  },
  successBody: {
    fontFamily: fonts.sans,
    fontSize: 15,
    color: colors.subtle,
    textAlign: 'center',
    marginBottom: spacing.l,
    lineHeight: 22,
  },
});
