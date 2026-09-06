import { Ionicons } from '@expo/vector-icons';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchPaymentUrl } from '../api/callables';
import { Backdrop, GlassCard } from '../components/Glass';
import { GlassHeader } from '../components/GlassHeader';
import { FadeSlideIn } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { daysUntilDue, isPayableStatus, statusLabelKey } from '../lib/loanStatus';
import { formatDate, formatMxn } from '../lib/money';
import { colors, fonts, radii, spacing } from '../theme';

interface LoanDoc {
  id: string;
  status?: string;
  amount?: number;
  principalAmount?: number;
  totalRepaymentAmount?: number;
  total?: number;
  createdAt?: { seconds: number };
  dueDate?: { seconds: number };
  loanRef?: string;
}

// Countdown look: calm aqua while far, gold as the date nears, red when due
// or past — the same status vocabulary the chips already speak.
function dueLook(days: number): { bg: string; fg: string } {
  if (days > 7) return { bg: colors.aquaTint, fg: colors.brandLight };
  if (days > 2) return { bg: colors.goldTint, fg: colors.gold };
  return { bg: colors.dangerSoft, fg: colors.danger };
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
        <View style={{ paddingTop: insets.top }}>
          <GlassHeader title={t('loans.title')} />
        </View>
        <View style={{ padding: spacing.l, paddingTop: spacing.s, gap: spacing.m }}>
          <Skeleton height={120} radius={radii.l} />
          <Skeleton height={120} radius={radii.l} />
          <Skeleton height={120} radius={radii.l} />
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop>
        <View style={styles.center}>
          <Text style={styles.error}>{t('loans.loadError')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
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
        contentContainerStyle={{ padding: spacing.l, paddingTop: spacing.s, flexGrow: 1 }}
        data={loans}
        keyExtractor={(loan) => loan.id}
        ListEmptyComponent={
          <FadeSlideIn style={styles.emptyWrap}>
            <View style={styles.emptyIcon}>
              <Ionicons name="leaf-outline" size={28} color={colors.brandLight} />
            </View>
            <Text style={styles.emptyTitle}>{t('loans.emptyTitle')}</Text>
            <Text style={styles.empty}>{t('loans.empty')}</Text>
          </FadeSlideIn>
        }
        ListHeaderComponent={payError ? <Text style={styles.error}>{payError}</Text> : null}
        renderItem={({ item, index }) => {
          const look = statusLook(item.status);
          return (
            <FadeSlideIn index={Math.min(index, 6)}>
              <GlassCard style={{ marginBottom: spacing.m }}>
                <View style={styles.cardInner}>
                  <View style={styles.cardTop}>
                    <View style={[styles.iconCircle, { backgroundColor: look.bg }]}>
                      <Ionicons name={look.icon} size={20} color={look.fg} />
                    </View>
                    <View style={styles.cardMain}>
                      <Text style={styles.amount}>
                        {formatMxn(item.principalAmount ?? item.amount)}
                      </Text>
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
                  {(() => {
                    const days = isPayableStatus(item.status) ? daysUntilDue(item.dueDate) : null;
                    if (days === null) return null;
                    const look = dueLook(days);
                    const label =
                      days > 1
                        ? t('loans.dueIn', { days })
                        : days === 1
                          ? t('loans.dueTomorrow')
                          : days === 0
                            ? t('loans.dueToday')
                            : t('loans.overdueDays', { days: Math.abs(days) });
                    return (
                      <View style={[styles.dueChip, { backgroundColor: look.bg }]}>
                        <Ionicons name="time-outline" size={13} color={look.fg} />
                        <Text style={[styles.dueText, { color: look.fg }]}>{label}</Text>
                      </View>
                    );
                  })()}
                  {isPayableStatus(item.status) ? (
                    <PrimaryButton
                      label={payingId === item.id ? t('loans.paying') : t('loans.pay')}
                      onPress={() => void pay(item.id)}
                      disabled={payingId !== null && payingId !== item.id}
                      busy={payingId === item.id}
                      style={{ marginTop: spacing.m }}
                    />
                  ) : null}
                </View>
              </GlassCard>
            </FadeSlideIn>
          );
        }}
      />
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  emptyWrap: { alignItems: 'center', marginTop: spacing.xl * 2, paddingHorizontal: spacing.l },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    backgroundColor: colors.aquaTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.m,
  },
  emptyTitle: { fontFamily: fonts.display, fontSize: 22, color: colors.text, marginBottom: spacing.s },
  empty: { fontFamily: fonts.sans, color: colors.subtle, textAlign: 'center', lineHeight: 21 },
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
  amount: {
    fontFamily: fonts.sansBold,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.3,
    fontVariant: ['tabular-nums'],
  },
  meta: {
    fontFamily: fonts.sans,
    color: colors.subtle,
    fontSize: 13.5,
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
  chip: { borderRadius: radii.pill, paddingHorizontal: spacing.m, paddingVertical: 6 },
  dueChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 5,
    marginTop: spacing.m,
  },
  dueText: { fontFamily: fonts.sansBold, fontSize: 12.5, fontVariant: ['tabular-nums'] },
  chipText: { fontFamily: fonts.sansBold, fontSize: 12 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
