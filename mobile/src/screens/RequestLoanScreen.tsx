import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
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

import { fetchLoanConfig, submitLoanRequest, type LoanConfig } from '../api/callables';
import { useAuth } from '../hooks/useAuth';
import { friendlyError } from '../lib/errors';
import { auth, db } from '../lib/firebase';
import { formatMxn, previewTotal } from '../lib/money';
import { colors, spacing } from '../theme';
import type { RootStackParamList } from '../types';

const MIN_AMOUNT = 500;
const MAX_AMOUNT = 5000;

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
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{t('request.priceUnavailable')}</Text>
        <Pressable style={styles.button} onPress={() => setRetryToken((n) => n + 1)}>
          <Text style={styles.buttonText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  if (successRef) {
    return (
      <View style={styles.center}>
        <Text style={styles.successTitle}>{t('request.successTitle')}</Text>
        <Text style={styles.successBody}>{t('request.successBody', { ref: successRef })}</Text>
        <Pressable style={styles.button} onPress={() => navigation.navigate('Loans')}>
          <Text style={styles.buttonText}>{t('loans.title')}</Text>
        </Pressable>
      </View>
    );
  }

  const feePercent = config ? Math.round(config.feeRate * 1000) / 10 : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.l }}>
      <Text style={styles.label}>{t('request.amountLabel')}</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={amountText}
        onChangeText={setAmountText}
        editable={!submitting}
        testID="request-amount"
      />
      <Text style={styles.help}>
        {t('request.amountHelp', { min: formatMxn(MIN_AMOUNT), max: formatMxn(MAX_AMOUNT) })}
      </Text>

      {feePercent !== null ? (
        <Text style={styles.priceLine}>{t('request.feeLine', { feePercent })}</Text>
      ) : null}
      {total !== null ? (
        <>
          <Text style={styles.priceLine}>{t('request.totalLine', { total: formatMxn(total) })}</Text>
          <Text style={styles.help}>{t('request.totalNote')}</Text>
        </>
      ) : null}

      <Text style={styles.terms}>{t('request.terms')}</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, (!amountValid || submitting) && styles.buttonDisabled]}
        onPress={() => void submit()}
        disabled={!amountValid || submitting}
        testID="request-submit"
      >
        {submitting ? (
          <ActivityIndicator color={colors.primaryText} />
        ) : (
          <Text style={styles.buttonText}>{t('request.submit')}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  label: { fontSize: 14, color: colors.text, marginBottom: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.m,
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  help: { color: colors.subtle, fontSize: 13, marginTop: spacing.xs },
  priceLine: { color: colors.text, fontSize: 16, marginTop: spacing.m },
  terms: { color: colors.subtle, fontSize: 13, marginTop: spacing.l },
  error: { color: colors.danger, marginTop: spacing.m, textAlign: 'center' },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.primaryText, fontSize: 16, fontWeight: '600' },
  successTitle: { fontSize: 24, fontWeight: '700', color: colors.primary, marginBottom: spacing.m },
  successBody: { fontSize: 15, color: colors.text, textAlign: 'center', marginBottom: spacing.l },
});
