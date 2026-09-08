/**
 * Request — the paper board. The amount is the first thing on the screen
 * (64px, blinking caret), the term line names the deduction, and the
 * disclosure line sits directly beneath at 13px: total to repay, the fee,
 * and the CAT the server published. Never hidden, never behind a tap. The
 * pill keypad ends in the one green control: `Solicitar 8,000`.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { doc, getDoc } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchLoanConfig, submitLoanRequest, type LoanConfig } from '../api/callables';
import { Backdrop } from '../components/Glass';
import { GlassHeader } from '../components/GlassHeader';
import { FadeSlideIn, PressableScale, useReducedMotion } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { DotLabel } from '../components/Ui';
import { PageColumn } from '../components/WebLayout';
import { useAuth } from '../hooks/useAuth';
import { friendlyError } from '../lib/errors';
import { auth, db } from '../lib/firebase';
import { useColumn } from '../lib/layout';
import { installmentAmounts, numeral, termsFor } from '../lib/loanView';
import { previewTotal } from '../lib/money';
import { colors, fonts, motion, radii, spacing, type } from '../theme';
import type { RootStackParamList } from '../types';

const MIN_AMOUNT = 500;
const MAX_AMOUNT = 5000;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'] as const;

interface EmployeeDoc {
  employerCode?: string;
  bankClabe?: string;
  [key: string]: unknown;
}

/** The blinking caret: 1.1s, two steps, stopped under reduced motion. */
function Caret() {
  const reduced = useReducedMotion();
  const on = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(motion.caretBlink / 2),
        Animated.timing(on, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(motion.caretBlink / 2),
        Animated.timing(on, { toValue: 1, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [on, reduced]);
  return <Animated.View style={[styles.caret, { opacity: on }]} />;
}

export function RequestLoanScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestLoan'>;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const column = useColumn(520);
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
        // Pricing and the borrower's own doc are both prerequisites of the
        // screen; either failing lands on the same retry. Without a
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

  const min = config?.minAmount ?? MIN_AMOUNT;
  const max = config?.maxAmount ?? MAX_AMOUNT;
  const amount = Number(amountText || '0');
  const amountValid = Number.isInteger(amount) && amount >= min && amount <= max && amount % 100 === 0;
  const termDays = typeof config?.defaultTermDays === 'number' ? config.defaultTermDays : 30;
  const terms = config ? termsFor(config, termDays) : undefined;
  const total = config && amountValid ? previewTotal(amount, config.feeRate) : null;
  const perInstallment = total !== null ? installmentAmounts(total, terms) : null;
  const feePercent = config ? Math.round(config.feeRate * 1000) / 10 : null;
  const cat = typeof terms?.catPercent === 'number' ? terms.catPercent : null;

  const press = (key: (typeof KEYS)[number]) => {
    if (submitting) return;
    setError('');
    if (key === '⌫') {
      setAmountText((v) => v.slice(0, -1));
      return;
    }
    setAmountText((v) => {
      const next = (v === '0' ? '' : v) + key;
      return next.replace(/^0+(?=\d)/, '').slice(0, 5);
    });
  };

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
        termDays,
      });
      setSuccessRef(result.loanRef || result.loanId);
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  };

  if (status === 'loading') {
    return (
      <Backdrop variant="paper">
        <View style={{ paddingTop: insets.top }}>
          <GlassHeader title={t('request.label')} />
        </View>
        <View style={[styles.body, column]}>
          <View style={{ flex: 1 }} />
          <Skeleton width={160} height={14} radius={radii.pill} />
          <Skeleton width={220} height={64} radius={radii.s} style={{ marginTop: spacing.m }} />
          <Skeleton height={14} radius={radii.pill} style={{ marginTop: spacing.m }} />
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop variant="paper">
        <View style={styles.center}>
          <Text style={styles.error}>{t('request.priceUnavailable')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
        </View>
      </Backdrop>
    );
  }

  if (successRef) {
    return (
      <Backdrop variant="paper">
        <View style={[styles.body, { paddingTop: insets.top + spacing.l }, column]}>
          <DotLabel size={14}>{t('request.receivedLabel')}</DotLabel>
          <View style={{ flex: 1 }} />
          <FadeSlideIn>
            <Text style={styles.title}>{t('request.successTitle')}</Text>
            <Text style={styles.quiet}>{t('request.successBody', { ref: successRef })}</Text>
            <PrimaryButton
              variant="ink"
              label={t('request.seeLoans')}
              onPress={() => navigation.navigate('Loans', { filter: 'all' })}
              style={{ marginTop: spacing.l }}
            />
          </FadeSlideIn>
        </View>
      </Backdrop>
    );
  }

  const installments = terms?.installments?.length ?? 1;
  const each = perInstallment ? numeral(perInstallment[0]) : '—';

  return (
    <Backdrop variant="paper">
      <View style={{ paddingTop: insets.top }}>
        <PageColumn maxWidth={520}>
          <GlassHeader title={t('request.label')} right={<DotLabel size={12}>{t('request.oneStep')}</DotLabel>} />
        </PageColumn>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.body, column]} keyboardShouldPersistTaps="handled">
        <FadeSlideIn index={0}>
          <Text style={styles.payTo}>{t('request.payTo')}</Text>
          <View style={styles.payWho}>
            <View style={styles.count}>
              <Text style={styles.countText}>{installments}</Text>
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.payWhoText}>{t('request.term', { count: installments, each })}</Text>
              <Text style={styles.payWhoQuiet}>{t('request.termIn', { days: terms?.installments?.[0]?.dueInDays ?? termDays })}</Text>
            </View>
          </View>
        </FadeSlideIn>

        <View style={{ flex: 1, minHeight: spacing.xl }} />

        <FadeSlideIn index={1}>
          <View style={styles.amountRow} accessibilityLabel={`${numeral(amount)} pesos`}>
            <Text style={styles.amount}>{amountText ? numeral(amount) : '0'}</Text>
            <Text style={styles.amountUnit}>{t('common.mxn')}</Text>
            <Caret />
          </View>
          <Text style={[styles.line, !amountValid && amountText !== '' && amountText !== '1000' && { color: colors.danger }]}>
            {t('request.amountHelp', { min: numeral(min), max: numeral(max) })}
          </Text>
          {/* Cost in plain sight — same screen, no tap, never smaller than 13px. */}
          <Text style={styles.disclosure} testID="request-disclosure">
            {total !== null
              ? cat !== null
                ? t('request.disclosure', { total: numeral(total), fee: feePercent, cat })
                : t('request.disclosureNoCat', { total: numeral(total), fee: feePercent })
              : t('request.amountHelp', { min: numeral(min), max: numeral(max) })}
          </Text>
          <Text style={styles.line}>{t('request.terms')}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </FadeSlideIn>

        <FadeSlideIn index={2}>
          <View style={styles.pad}>
            {[0, 3, 6, 9].map((row) => (
              <View key={row} style={styles.padRow}>
                {KEYS.slice(row, row + 3).map((k) => (
                  <PressableScale
                    key={k}
                    onPress={() => press(k)}
                    accessibilityRole="button"
                    accessibilityLabel={k === '⌫' ? 'borrar' : k}
                    style={styles.key}
                    testID={`key-${k === '⌫' ? 'del' : k}`}
                  >
                    <Text style={styles.keyText}>{k}</Text>
                  </PressableScale>
                ))}
              </View>
            ))}
          </View>
          <PrimaryButton
            label={amountValid ? t('request.submit', { amount: numeral(amount) }) : t('request.submitEmpty')}
            onPress={() => void submit()}
            disabled={!amountValid}
            busy={submitting}
            style={{ marginTop: 6 }}
            testID="request-submit"
          />
        </FadeSlideIn>
      </ScrollView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, paddingHorizontal: 28, paddingBottom: 28, minHeight: 620 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  payTo: { fontFamily: fonts.sans, fontSize: 15, color: colors.inkSoft, marginTop: spacing.m },
  payWho: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  count: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.mark, alignItems: 'center', justifyContent: 'center' },
  countText: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.markInk },
  payWhoText: { fontFamily: fonts.sans, fontSize: 22, color: colors.ink, flexShrink: 1 },
  payWhoQuiet: { fontFamily: fonts.sansLight, color: colors.mute, fontSize: 15, marginTop: 2 },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  amount: { fontFamily: fonts.sans, fontSize: type.amount, letterSpacing: -2.5, lineHeight: 70, color: colors.ink, fontVariant: ['tabular-nums'] },
  amountUnit: { fontFamily: fonts.sansLight, fontSize: 22, color: colors.mute },
  caret: { width: 2, height: 54, backgroundColor: colors.ink, alignSelf: 'center', marginLeft: 2 },
  line: { fontFamily: fonts.sans, fontSize: 13, color: colors.inkSoft, marginTop: 10, lineHeight: 19 },
  disclosure: { fontFamily: fonts.sansMedium, fontSize: 13, color: colors.ink, marginTop: 12, lineHeight: 19 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginTop: spacing.m, lineHeight: 19 },
  pad: { marginTop: spacing.l, gap: 6 },
  padRow: { flexDirection: 'row', gap: 6 },
  key: { flex: 1, height: 52, borderRadius: radii.pill, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontFamily: fonts.sans, fontSize: 22, color: colors.ink },
  title: { fontFamily: fonts.display, fontSize: type.display, lineHeight: 44, color: colors.ink, letterSpacing: -0.4 },
  quiet: { fontFamily: fonts.sansLight, fontSize: 17, lineHeight: 25, color: colors.inkSoft, marginTop: spacing.m, maxWidth: 320 },
});
