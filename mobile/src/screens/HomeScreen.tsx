import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { doc, onSnapshot } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FunpayMark, FunpayWordmark } from '../components/FunpayLogo';
import { Backdrop, GlassCard } from '../components/Glass';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { formatMxn } from '../lib/money';
import { colors, fonts, gradient, microLabel, radii, spacing } from '../theme';
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
  const insets = useSafeAreaInsets();
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
          <Text style={styles.error}>{t('home.loadError')}</Text>
          <Pressable onPress={() => setRetryToken((n) => n + 1)}>
            <LinearGradient colors={gradient} style={styles.retryButton}>
              <Text style={styles.buttonText}>{t('common.retry')}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </Backdrop>
    );
  }

  const verified = employee?.kycStatus === 'approved';
  const name = employee?.name || user?.email || '';
  const firstName = String(name).split(' ')[0];

  return (
    <Backdrop>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: spacing.l, paddingTop: insets.top + spacing.l }}
      >
        <View style={styles.topRow}>
          <FunpayMark size={34} />
          <Pressable
            onPress={() => void logOut()}
            accessibilityRole="button"
            accessibilityLabel={t('common.signOut')}
            style={styles.signOutChip}
          >
            <Ionicons name="log-out-outline" size={18} color={colors.subtle} />
            <Text style={styles.signOutText}>{t('common.signOut')}</Text>
          </Pressable>
        </View>

        <Text style={styles.greeting}>{t('home.greeting', { name: firstName })}</Text>

        {/* The dark element over the light world: the borrower's credit line
            as a payment-card, deep brand gradient with the gold dot. */}
        <LinearGradient
          colors={gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.card}
        >
          <View style={styles.cardTopRow}>
            <Text style={styles.cardLabel}>{t('home.creditLine')}</Text>
            <View style={styles.cardDot} />
          </View>
          <Text style={styles.cardAmount}>{formatMxn(employee?.creditLimit)}</Text>
          <View style={styles.cardBottomRow}>
            <Text style={styles.cardSub}>
              {t('home.available')}: {formatMxn(employee?.availableCredit ?? employee?.creditLimit)}
            </Text>
            <FunpayWordmark size={15} color="rgba(255,255,255,0.85)" />
          </View>
        </LinearGradient>

        {!verified ? (
          <GlassCard style={{ marginTop: spacing.l }}>
            <Text style={styles.notice}>{t('home.notVerified')}</Text>
          </GlassCard>
        ) : null}

        {/* Frosted action tiles, icon-led like the reference dashboards. */}
        <View style={styles.actions}>
          <Pressable style={styles.actionWrap} onPress={() => navigation.navigate('Loans')}>
            <GlassCard style={styles.actionCard}>
              <View style={styles.actionInner}>
                <View style={styles.actionIcon}>
                  <Ionicons name="wallet-outline" size={22} color={colors.brand} />
                </View>
                <Text style={styles.actionText}>{t('home.myLoans')}</Text>
              </View>
            </GlassCard>
          </Pressable>

          {/* The server re-checks eligibility on every requestLoan; hiding
              the tile for unverified borrowers is UX, not the security
              boundary. */}
          {verified ? (
            <Pressable style={styles.actionWrap} onPress={() => navigation.navigate('RequestLoan')}>
              <GlassCard style={styles.actionCard}>
                <View style={styles.actionInner}>
                  <View style={[styles.actionIcon, { backgroundColor: colors.goldTint }]}>
                    <Ionicons name="add" size={24} color={colors.gold} />
                  </View>
                  <Text style={styles.actionText}>{t('home.requestLoan')}</Text>
                </View>
              </GlassCard>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.l,
  },
  signOutChip: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: spacing.s },
  signOutText: { fontFamily: fonts.sansMedium, color: colors.subtle, fontSize: 13 },
  greeting: {
    fontFamily: fonts.display,
    fontSize: 32,
    color: colors.text,
    marginBottom: spacing.l,
    letterSpacing: -0.3,
  },
  card: {
    borderRadius: radii.xl,
    padding: spacing.l,
    shadowColor: colors.brand,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardLabel: { ...microLabel, color: colors.aqua },
  cardDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.gold },
  cardAmount: {
    fontFamily: fonts.sansBold,
    fontSize: 42,
    color: colors.onBrand,
    marginTop: spacing.m,
    marginBottom: spacing.l,
    letterSpacing: -0.5,
  },
  cardBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  cardSub: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.aqua },
  notice: {
    fontFamily: fonts.sans,
    color: colors.subtle,
    fontSize: 14,
    lineHeight: 21,
    padding: spacing.m,
  },
  actions: { flexDirection: 'row', gap: spacing.m, marginTop: spacing.l },
  actionWrap: { flex: 1 },
  actionCard: { flex: 1 },
  actionInner: { padding: spacing.m, alignItems: 'flex-start', gap: spacing.m, minHeight: 108 },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: radii.m,
    backgroundColor: colors.aquaTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontFamily: fonts.sansBold, color: colors.text, fontSize: 14.5 },
  retryButton: { borderRadius: radii.pill, paddingVertical: spacing.m, paddingHorizontal: spacing.xl },
  buttonText: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 16 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
