/**
 * Créditos — the repayment board on paper. Each credit is its amount as the
 * title, its term as the quiet line, a summary that names the employer as
 * the deductor, and its deductions as pills: done (ink circle, struck
 * through), next (white, floating), upcoming (paper). Filter pills at the
 * top. The pay control is an ink pill — green is spent on the active state.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchPaymentUrl } from '../api/callables';
import { Backdrop } from '../components/Glass';
import { GlassHeader } from '../components/GlassHeader';
import { FadeSlideIn } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { Pill } from '../components/Ui';
import { PageColumn } from '../components/WebLayout';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { useColumn } from '../lib/layout';
import { daysUntilDue, isPayableStatus, statusLabelKey } from '../lib/loanStatus';
import { isActiveLoan, isPaidLoan, numeral, principalOf, shortDate, totalOf, type LoanDoc } from '../lib/loanView';
import { colors, fonts, radii, shadowFloat, spacing, type } from '../theme';
import type { RootStackParamList } from '../types';

type Filter = 'all' | 'active' | 'paid';

export function LoansScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Loans'>) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const column = useColumn(560);
  const [loans, setLoans] = useState<LoanDoc[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payError, setPayError] = useState('');
  const [filter, setFilter] = useState<Filter>(route.params?.filter ?? 'all');

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

  const header = (
    <View style={{ paddingTop: insets.top }}>
      <PageColumn maxWidth={560}>
        <GlassHeader title={t('loans.label')} />
      </PageColumn>
    </View>
  );

  if (status === 'loading') {
    return (
      <Backdrop variant="paper">
        {header}
        <View style={[styles.list, column]}>
          <Skeleton height={44} radius={radii.pill} />
          <Skeleton height={140} radius={radii.m} style={{ marginTop: spacing.l }} />
          <Skeleton height={140} radius={radii.m} style={{ marginTop: spacing.m }} />
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop variant="paper">
        <View style={styles.center}>
          <Text style={styles.error}>{t('loans.loadError')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
        </View>
      </Backdrop>
    );
  }

  const activeCount = loans.filter(isActiveLoan).length;
  const paidCount = loans.filter(isPaidLoan).length;
  const shown = loans.filter((l) => (filter === 'active' ? isActiveLoan(l) : filter === 'paid' ? isPaidLoan(l) : true));
  const counts: Record<Filter, number> = { all: loans.length, active: activeCount, paid: paidCount };

  return (
    <Backdrop variant="paper">
      {header}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={[styles.list, { flexGrow: 1 }, column]}
        data={shown}
        keyExtractor={(loan) => loan.id}
        ListHeaderComponent={
          <View>
            <View style={styles.pills}>
              {(['all', 'active', 'paid'] as Filter[]).map((f) => (
                <Pill
                  key={f}
                  label={t(f === 'all' ? 'home.filterAll' : f === 'active' ? 'home.filterActive' : 'home.filterPaid')}
                  active={filter === f}
                  count={counts[f]}
                  onPress={() => setFilter(f)}
                  testID={`loans-filter-${f}`}
                />
              ))}
            </View>
            {payError ? <Text style={styles.error}>{payError}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          <FadeSlideIn style={styles.empty}>
            <Text style={styles.title}>{t('loans.emptyTitle')}</Text>
            <Text style={styles.quiet}>{t('loans.empty')}</Text>
          </FadeSlideIn>
        }
        renderItem={({ item, index }) => {
          const paid = isPaidLoan(item);
          const active = isActiveLoan(item);
          const days = isPayableStatus(item.status) ? daysUntilDue(item.dueDate) : null;
          const schedule =
            item.repaymentSchedule && item.repaymentSchedule.length > 0
              ? item.repaymentSchedule
              : [{ number: 1, amount: totalOf(item) ?? 0, dueDate: item.dueDate ?? null }];
          const total = totalOf(item);
          return (
            <FadeSlideIn index={Math.min(index, 6)} style={styles.item}>
              <View style={styles.itemHead}>
                <Text style={styles.amount}>
                  {numeral(principalOf(item))}
                  <Text style={styles.amountUnit}> {t('common.mxn')}</Text>
                </Text>
                <Text style={[styles.status, active && { color: colors.markInk }, item.status === 'overdue' && { color: colors.danger }]}>
                  {t(statusLabelKey(item.status))}
                </Text>
              </View>
              <Text style={styles.quietLine}>
                {t('loans.requested')} {shortDate(item.createdAt)} · {t('loans.total').toLowerCase()} {numeral(total)} {t('common.mxn')}
              </Text>
              <Text style={styles.summary}>
                {item.employerName ? t('loans.deductedByNamed', { employer: item.employerName }) : t('loans.deductedBy')}
                {days !== null ? (
                  <Text style={styles.summaryBold}>
                    {' '}
                    {days > 1
                      ? t('loans.dueIn', { days })
                      : days === 1
                        ? t('loans.dueTomorrow')
                        : days === 0
                          ? t('loans.dueToday')
                          : t('loans.overdueDays', { days: Math.abs(days) })}
                    .
                  </Text>
                ) : null}
              </Text>
              <View style={styles.timeline}>
                {schedule.slice(0, 4).map((step, i) => {
                  const done = paid;
                  const now = !paid && active && i === 0;
                  return (
                    <View key={step.number} style={[styles.step, now && styles.stepNow]}>
                      <View style={[styles.stepDot, done && styles.stepDotDone]}>
                        <Text style={[styles.stepDotText, done && { color: colors.cream }]}>{done ? '✓' : step.number}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.stepDate}>{shortDate(step.dueDate)}</Text>
                        <Text style={styles.stepSub}>
                          {t('loans.deduction', { n: step.number })}
                          {now ? ` · ${t('loans.nextPayday')}` : ''}
                        </Text>
                      </View>
                      <Text style={[styles.stepValue, done && styles.stepValueDone]}>{numeral(step.amount)}</Text>
                    </View>
                  );
                })}
              </View>
              {isPayableStatus(item.status) ? (
                <PrimaryButton
                  variant="ink"
                  label={payingId === item.id ? t('loans.paying') : t('loans.pay', { amount: numeral(total) })}
                  onPress={() => void pay(item.id)}
                  disabled={payingId !== null && payingId !== item.id}
                  busy={payingId === item.id}
                  style={{ marginTop: spacing.m }}
                />
              ) : null}
            </FadeSlideIn>
          );
        }}
      />
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 28, paddingTop: spacing.s, paddingBottom: 28 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  pills: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: spacing.l },
  empty: { marginTop: spacing.xl * 2 },
  title: { fontFamily: fonts.display, fontSize: type.display, lineHeight: 44, color: colors.ink, letterSpacing: -0.4 },
  quiet: { fontFamily: fonts.sansLight, fontSize: 17, lineHeight: 25, color: colors.inkSoft, marginTop: spacing.m, maxWidth: 320 },
  item: { marginBottom: spacing.xl },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  amount: { fontFamily: fonts.sans, fontSize: 34, letterSpacing: -1, color: colors.ink, fontVariant: ['tabular-nums'] },
  amountUnit: { fontFamily: fonts.sansLight, fontSize: 16, letterSpacing: 0, color: colors.mute },
  status: { fontFamily: fonts.sansMedium, fontSize: 13, color: colors.inkSoft },
  quietLine: { fontFamily: fonts.sansLight, fontSize: 15, color: colors.mute, marginTop: 2 },
  summary: { fontFamily: fonts.sansLight, fontSize: 15, lineHeight: 23, color: colors.inkSoft, marginTop: spacing.m, maxWidth: 340 },
  summaryBold: { fontFamily: fonts.sansBold, color: colors.ink },
  timeline: { marginTop: spacing.l, gap: 8 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radii.pill, backgroundColor: colors.paper },
  stepNow: { backgroundColor: '#ffffff', ...shadowFloat },
  stepDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.mark, alignItems: 'center', justifyContent: 'center' },
  stepDotDone: { backgroundColor: colors.ink },
  stepDotText: { fontFamily: fonts.sansBold, fontSize: 11, color: colors.markInk },
  stepDate: { fontFamily: fonts.sans, fontSize: 14, color: colors.ink },
  stepSub: { fontFamily: fonts.sans, fontSize: 12, color: colors.mute },
  stepValue: { fontFamily: fonts.sansBold, fontSize: 14, color: colors.ink, fontVariant: ['tabular-nums'] },
  stepValueDone: { fontFamily: fonts.sans, color: colors.mute, textDecorationLine: 'line-through' },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
