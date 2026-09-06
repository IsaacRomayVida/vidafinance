import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { doc, onSnapshot } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { formatMxn } from '../lib/money';
import { colors, spacing } from '../theme';
import type { RootStackParamList } from '../types';

interface EmployeeDoc {
  name?: string;
  kycStatus?: string;
  creditLimit?: number;
  availableCredit?: number;
  [key: string]: unknown;
}

export function HomeScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
}) {
  const { t } = useTranslation();
  const { user, logOut } = useAuth();
  const [employee, setEmployee] = useState<EmployeeDoc | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryToken, setRetryToken] = useState(0);

  const uid = user?.uid;
  useEffect(() => {
    if (!uid) return;
    setStatus('loading');
    // onSnapshot WITH an error callback, always — a permission error or an
    // offline client must land on the error card with a retry, never an
    // infinite spinner (the F5/F7 lesson from the web app, applied here from
    // day one).
    const unsubscribe = onSnapshot(
      doc(db, 'employees', uid),
      (snapshot) => {
        setEmployee((snapshot.data() as EmployeeDoc | undefined) ?? null);
        setStatus('ready');
      },
      () => setStatus('error')
    );
    return unsubscribe;
  }, [uid, retryToken]);

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
        <Text style={styles.error}>{t('home.loadError')}</Text>
        <Pressable style={styles.button} onPress={() => setRetryToken((n) => n + 1)}>
          <Text style={styles.buttonText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  const verified = employee?.kycStatus === 'approved';
  const name = employee?.name || user?.email || '';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.l }}>
      <Text style={styles.greeting}>{t('home.greeting', { name })}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t('home.creditLine')}</Text>
        <Text style={styles.cardAmount}>{formatMxn(employee?.creditLimit)}</Text>
        <Text style={styles.cardSub}>
          {t('home.available')}: {formatMxn(employee?.availableCredit ?? employee?.creditLimit)}
        </Text>
      </View>

      {!verified ? <Text style={styles.notice}>{t('home.notVerified')}</Text> : null}

      <Pressable style={styles.button} onPress={() => navigation.navigate('Loans')}>
        <Text style={styles.buttonText}>{t('home.myLoans')}</Text>
      </Pressable>

      {/* The server re-checks eligibility on every requestLoan; hiding the
          button for unverified borrowers is UX, not the security boundary. */}
      {verified ? (
        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={() => navigation.navigate('RequestLoan')}
        >
          <Text style={styles.buttonSecondaryText}>{t('home.requestLoan')}</Text>
        </Pressable>
      ) : null}

      <Pressable style={styles.signOut} onPress={() => void logOut()}>
        <Text style={styles.signOutText}>{t('common.signOut')}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  greeting: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: spacing.l },
  card: {
    backgroundColor: colors.chipBg,
    borderRadius: 12,
    padding: spacing.l,
    marginBottom: spacing.l,
  },
  cardLabel: { fontSize: 14, color: colors.subtle },
  cardAmount: { fontSize: 34, fontWeight: '700', color: colors.primary, marginVertical: spacing.xs },
  cardSub: { fontSize: 14, color: colors.subtle },
  notice: { color: colors.subtle, fontSize: 14, marginBottom: spacing.l },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: spacing.m,
    alignItems: 'center',
    marginBottom: spacing.m,
  },
  buttonText: { color: colors.primaryText, fontSize: 16, fontWeight: '600' },
  buttonSecondary: { backgroundColor: colors.chipBg },
  buttonSecondaryText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  signOut: { alignItems: 'center', marginTop: spacing.l },
  signOutText: { color: colors.subtle, fontSize: 14 },
  error: { color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
