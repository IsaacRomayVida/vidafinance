import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchPaymentUrl } from '../api/callables';
import { Backdrop, GlassCard } from '../components/Glass';
import { GlassHeader } from '../components/GlassHeader';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { isPayableStatus, statusLabelKey } from '../lib/loanStatus';
import { formatDate, formatMxn } from '../lib/money';
import { colors, fonts, gradient, radii, spacing } from '../theme';

interface LoanDoc {
  id: string;
  status?: string;
  amount?: number;
  principalAmount?: number;
  totalRepaymentAmount?: number;
  total?: number;
  createdAt?: { seconds: number };
  loanRef?: string;
}

// Tint + icon per status family — gold while money is in flight, brand
// aqua while a loan is live, quiet neutral once settled, red when
// something needs attention. Unknown statuses read neutral, never alarming.
function statusLook(status?: string): { bg: string; fg: string; icon: keyof typeof Ionicons.glyphMap } {
  switch (status) {
    case 'active':
    case 'disbursed':
      return { bg: colors.aquaTint, fg: colors.brandLight, icon: 'trending-up' };
    case 'pending':
    case 'under_review':
    case 'approved':
    case 'disbursement_queued':
      return { bg: colors.goldTint, fg: colors.gold, icon: 'hourglass-outline' };
    case 'overdue':
    case 'in_collections':
    case 'disbursement_failed':
      return { bg: colors.dangerSoft, fg: colors.danger, icon: 'alert-circle-outline' };
    case 'repaid':
      return { bg: colors.neutralTint, fg: colors.subtle, icon: 'checkmark-circle-outline' };
    default:
      return { bg: colors.neutralTint, fg: colors.subtle, icon: 'ellipse-outline' };
  }
}

export function LoansScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [loans, setLoans] = useState<LoanDoc[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payError, setPayError] = useState('');

  const uid = user?.uid;
  useEffect(() => {
    if (!uid) return;
    setStatus('loading');
    // Same query MyLoans.tsx runs, same rule: onSnapshot always carries an
    // error callback so failure is a retry card, never an infinite spinner.
    const unsubscribe = onSnapshot(
      query(collection(db, 'loans'), where('employeeId', '==', uid)),
      (snapshot) => {
        const next = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LoanDoc, 'id'>) }));
        next.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
        setLoans(next);
        setStatus('ready');
      },
      () => setStatus('error')
    );
    return unsubscribe;
  }, [uid, retryToken]);

  const pay = async (loanId: string) => {
    if (payingId) return;
    setPayError('');
    setPayingId(loanId);
    try {
      const url = await fetchPaymentUrl(loanId);
      await Linking.openURL(url);
    } catch {
      setPayError(t('loans.payError'));
    } finally {
      setPayingId(null);
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
          <Text style={styles.error}>{t('loans.loadError')}</Text>
          <Pressable onPress={() => setRetryToken((n) => n + 1)}>
            <LinearGradient colors={gradient} style={styles.retryButton}>
              <Text style={styles.payButtonText}>{t('common.retry')}</Text>
            </LinearGradient>
          </Pressable>
        </View>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <View style={{ paddingTop: insets.top }}>
        <GlassHeader title={t('loans.title')} />
      </View>
      <FlatList
        style={styles.list}
        contentContainerStyle={{ padding: spacing.l, paddingTop: spacing.s }}
        data={loans}
        keyExtractor={(loan) => loan.id}
        ListEmptyComponent={<Text style={styles.empty}>{t('loans.empty')}</Text>}
        ListHeaderComponent={payError ? <Text style={styles.error}>{payError}</Text> : null}
        renderItem={({ item }) => {
          const look = statusLook(item.status);
          return (
            <GlassCard style={{ marginBottom: spacing.m }}>
              <View style={styles.cardInner}>
                <View style={styles.cardTop}>
                  <View style={[styles.iconCircle, { backgroundColor: look.bg }]}>
                    <Ionicons name={look.icon} size={20} color={look.fg} />
                  </View>
                  <View style={styles.cardMain}>
                    <Text style={styles.amount}>{formatMxn(item.principalAmount ?? item.amount)}</Text>
                    <Text style={styles.meta}>
                      {t('loans.total')}: {formatMxn(item.totalRepaymentAmount ?? item.total)}
                    </Text>
                    <Text style={styles.meta}>
                      {t('loans.requested')}: {formatDate(item.createdAt)}
                    </Text>
                  </View>
                  <View style={[styles.chip, { backgroundColor: look.bg }]}>
                    <Text style={[styles.chipText, { color: look.fg }]}>
                      {t(statusLabelKey(item.status))}
                    </Text>
                  </View>
                </View>
                {isPayableStatus(item.status) ? (
                  <Pressable
                    onPress={() => void pay(item.id)}
                    disabled={payingId !== null}
                    style={payingId === item.id && styles.payDisabled}
                  >
                    <LinearGradient
                      colors={gradient}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.payButton}
                    >
                      <Text style={styles.payButtonText}>
                        {payingId === item.id ? t('loans.paying') : t('loans.pay')}
                      </Text>
                    </LinearGradient>
                  </Pressable>
                ) : null}
              </View>
            </GlassCard>
          );
        }}
      />
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  empty: { fontFamily: fonts.sans, color: colors.faint, textAlign: 'center', marginTop: spacing.xl },
  cardInner: { padding: spacing.m },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.m },
  iconCircle: {
    width: 42,
    height: 42,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  cardMain: { flex: 1 },
  amount: { fontFamily: fonts.sansBold, fontSize: 22, color: colors.text, letterSpacing: -0.3 },
  meta: { fontFamily: fonts.sans, color: colors.subtle, fontSize: 13.5, marginTop: 3 },
  chip: { borderRadius: radii.pill, paddingHorizontal: spacing.m, paddingVertical: 6 },
  chipText: { fontFamily: fonts.sansBold, fontSize: 12 },
  payButton: {
    borderRadius: radii.pill,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.m,
  },
  payDisabled: { opacity: 0.6 },
  payButtonText: { fontFamily: fonts.sansBold, color: colors.onBrand, fontSize: 15 },
  retryButton: { borderRadius: radii.pill, paddingVertical: spacing.m, paddingHorizontal: spacing.xl },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
