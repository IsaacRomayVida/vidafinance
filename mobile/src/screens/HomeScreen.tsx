import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { doc, onSnapshot } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { formatMxn } from '../lib/money';
import { colors, fonts, microLabel, radii, spacing } from '../theme';
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
        <ActivityIndicator color={colors.brand} size="large" />
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

      {/* The hero card: the borrower's credit line on the brand teal, the
          way every fintech wallet leads with its balance card. The gold dot
          is the same accent the favicon carries. */}
      <View style={styles.card}>
        <View style={styles.cardDot} />
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
  greeting: {
    fontFamily: fonts.display,
    fontSize: 30,
    color: colors.text,
    marginBottom: spacing.l,
    letterSpacing: -0.3,
  },
  card: {
    backgroundColor: colors.brand,
    borderRadius: radii.xl,
    padding: spacing.l,
    marginBottom: spacing.l,
    overflow: 'hidden',
  },
  cardDot: {
    position: 'absolute',
    top: spacing.l,
    right: spacing.l,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.gold,
  },
  cardLabel: { ...microLabel, color: colors.aqua },
  cardAmount: {
    fontFamily: fonts.sansBold,
    fontSize: 40,
    color: colors.onBrand,
    marginVertical: spacing.s,
    letterSpacing: -0.5,
  },
  cardSub: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.aqua },
  notice: {
    fontFamily: fonts.sans,
    color: colors.subtle,
    fontSize: 14,
    lineHeight: 21,
    backgroundColor: colors.goldSoft,
    borderRadius: radii.m,
    padding: spacing.m,
    marginBottom: spacing.l,
  },
  button: {
    backgroundColor: colors.brand,
    borderRadius: radii.m,
    padding: spacing.m,
    alignItems: 'center',
    marginBottom: spacing.m,
  },
  buttonText: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 16 },
  buttonSecondary: { backgroundColor: colors.aquaSoft },
  buttonSecondaryText: { fontFamily: fonts.sansBold, color: colors.brand, fontSize: 16 },
  signOut: { alignItems: 'center', marginTop: spacing.l, padding: spacing.s },
  signOutText: { fontFamily: fonts.sansMedium, color: colors.faint, fontSize: 14 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
