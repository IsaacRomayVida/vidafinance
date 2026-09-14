import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { doc, onSnapshot } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FunpayMark, FunpayWordmark } from '../components/FunpayLogo';
import { Backdrop, GlassCard } from '../components/Glass';
import { FadeSlideIn, PressableScale } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { formatMxn } from '../lib/money';
import { colors, fonts, gradient, microLabel, radii, spacing, type } from '../theme';
import type { RootStackParamList } from '../types';

interface EmployeeDoc {
  name?: string;
  metamapStatus?: string;
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
    // The page's own silhouette, pulsing — never a bare spinner.
    return (
      <Backdrop>
        <View style={[styles.container, { padding: spacing.l, paddingTop: insets.top + spacing.l }]}>
          <View style={styles.topRow}>
            <Skeleton width={34} height={34} radius={radii.pill} />
            <Skeleton width={90} height={20} radius={radii.s} />
          </View>
          <Skeleton width={'60%' as const} height={32} style={{ marginBottom: spacing.l }} />
          <Skeleton height={190} radius={radii.xl} />
          <View style={styles.actions}>
            <Skeleton height={108} radius={radii.l} style={{ flex: 1 }} />
            <Skeleton height={108} radius={radii.l} style={{ flex: 1 }} />
          </View>
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop>
        <View style={styles.center}>
          <Text style={styles.error}>{t('home.loadError')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
        </View>
      </Backdrop>
    );
  }

  // metamapStatus is the field the money path checks (requestLoan's
  // assertBorrowerIdentityVerified); kycStatus is display-only and no server
  // path ever writes 'approved' to it — gating on it kept this banner stuck
  // on "not verified" for verified borrowers.
  const verified = employee?.metamapStatus === 'verified';
  const name = employee?.name || user?.email || '';
  const firstName = String(name).split(' ')[0];
  const creditLimit = employee?.creditLimit ?? 0;
  const available = employee?.availableCredit ?? creditLimit;
  const usedRatio = creditLimit > 0 ? Math.min(Math.max(1 - available / creditLimit, 0), 1) : 0;

  return (
    <Backdrop>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: spacing.l, paddingTop: insets.top + spacing.l }}
      >
        <FadeSlideIn index={0}>
          <View style={styles.topRow}>
            <FunpayMark size={34} />
            <PressableScale
              onPress={() => void logOut()}
              accessibilityRole="button"
              accessibilityLabel={t('common.signOut')}
              style={styles.signOutChip}
            >
              <Ionicons name="log-out-outline" size={18} color={colors.subtle} />
              <Text style={styles.signOutText}>{t('common.signOut')}</Text>
            </PressableScale>
          </View>

          <Text style={styles.greeting}>{t('home.greeting', { name: firstName })}</Text>
        </FadeSlideIn>

        {/* The dark element over the light world: the borrower's credit line
            as a payment-card, deep brand gradient with the gold dot. */}
        <FadeSlideIn index={1}>
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
            <Text style={styles.cardAmount}>{formatMxn(creditLimit)}</Text>
            {/* Quiet usage track: how much of the line is in use. Purely
                informational — no numbers repeated, the bar says it. */}
            {creditLimit > 0 ? (
              <View
                style={styles.track}
                accessibilityLabel={`${Math.round(usedRatio * 100)}% utilizado`}
              >
                <View style={[styles.trackFill, { width: `${Math.max(usedRatio * 100, 2)}%` }]} />
              </View>
            ) : null}
            <View style={styles.cardBottomRow}>
              <Text style={styles.cardSub}>
                {t('home.available')}: {formatMxn(available)}
              </Text>
              <FunpayWordmark size={15} color="rgba(255,255,255,0.85)" />
            </View>
          </LinearGradient>
        </FadeSlideIn>

        {!verified ? (
          <FadeSlideIn index={2}>
            <GlassCard style={{ marginTop: spacing.l }}>
              <View style={styles.noticeInner}>
                <View style={styles.noticeIcon}>
                  <Ionicons name="shield-checkmark-outline" size={22} color={colors.gold} />
                </View>
                <View style={styles.noticeBody}>
                  <Text style={styles.noticeTitle}>{t('home.notVerifiedTitle')}</Text>
                  <Text style={styles.notice}>{t('home.notVerified')}</Text>
                  <Pressable
                    onPress={() => void Linking.openURL('https://funpay.mx')}
                    accessibilityRole="link"
                    hitSlop={8}
                  >
                    <Text style={styles.noticeLink}>{t('home.notVerifiedCta')}</Text>
                  </Pressable>
                </View>
              </View>
            </GlassCard>
          </FadeSlideIn>
        ) : null}

        {/* Frosted action tiles, icon-led like the reference dashboards. */}
        <View style={styles.actions}>
          <FadeSlideIn index={3} style={styles.actionWrap}>
            <PressableScale
              onPress={() => navigation.navigate('Loans')}
              accessibilityRole="button"
              accessibilityLabel={t('home.myLoans')}
            >
              <GlassCard style={styles.actionCard}>
                <View style={styles.actionInner}>
                  <View style={styles.actionIcon}>
                    <Ionicons name="wallet-outline" size={22} color={colors.brand} />
                  </View>
                  <Text style={styles.actionText}>{t('home.myLoans')}</Text>
                </View>
              </GlassCard>
            </PressableScale>
          </FadeSlideIn>

          {/* The server re-checks eligibility on every requestLoan; hiding
              the tile for unverified borrowers is UX, not the security
              boundary. */}
          {verified ? (
            <FadeSlideIn index={4} style={styles.actionWrap}>
              <PressableScale
                onPress={() => navigation.navigate('RequestLoan')}
                accessibilityRole="button"
                accessibilityLabel={t('home.requestLoan')}
              >
                <GlassCard style={styles.actionCard}>
                  <View style={styles.actionInner}>
                    <View style={[styles.actionIcon, { backgroundColor: colors.goldTint }]}>
                      <Ionicons name="add" size={24} color={colors.gold} />
                    </View>
                    <Text style={styles.actionText}>{t('home.requestLoan')}</Text>
                  </View>
                </GlassCard>
              </PressableScale>
            </FadeSlideIn>
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
    fontSize: type.display,
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
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
    marginTop: spacing.m,
    marginBottom: spacing.m,
    overflow: 'hidden',
  },
  trackFill: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.gold,
  },
  cardBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: spacing.s,
  },
  cardSub: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    color: colors.aqua,
    fontVariant: ['tabular-nums'],
  },
  noticeInner: { flexDirection: 'row', gap: spacing.m, padding: spacing.m },
  noticeIcon: {
    width: 44,
    height: 44,
    borderRadius: radii.m,
    backgroundColor: colors.goldTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeBody: { flex: 1 },
  noticeTitle: { fontFamily: fonts.sansBold, color: colors.text, fontSize: 15, marginBottom: 4 },
  notice: { fontFamily: fonts.sans, color: colors.subtle, fontSize: 14, lineHeight: 21 },
  noticeLink: {
    fontFamily: fonts.sansBold,
    color: colors.brandLight,
    fontSize: 14,
    marginTop: spacing.s,
    paddingVertical: 4,
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
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
