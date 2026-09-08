/**
 * Home — the leaf board. Capture first: the available credit is the 50px
 * numeral in the lower half where thumbs are; the active credit is a frosted
 * chip; the companion is a card of facts the user opens; the filter pills
 * sit at the bottom. One ink pill carries the single green on the screen.
 */
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Backdrop, GlassCard } from '../components/Glass';
import { FadeSlideIn, PressableScale } from '../components/motion';
import { PrimaryButton } from '../components/PrimaryButton';
import { Skeleton } from '../components/Skeleton';
import { TrackFill } from '../components/TrackFill';
import { Avatar, DotLabel, Pill, initialsOf } from '../components/Ui';
import { PageColumn } from '../components/WebLayout';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { useLayout } from '../lib/layout';
import {
  isActiveLoan,
  isPaidLoan,
  numeral,
  paidOf,
  principalOf,
  shortDate,
  totalOf,
  type LoanDoc,
} from '../lib/loanView';
import { assistGradient, colors, fonts, radii, shadowFloat, spacing, type } from '../theme';
import type { RootStackParamList } from '../types';

interface EmployeeDoc {
  name?: string;
  metamapStatus?: string;
  creditLimit?: number;
  availableCredit?: number;
  [key: string]: unknown;
}

const ON_LEAF = '#f4f7ee';
const shadow = { textShadowColor: 'rgba(20,40,10,0.4)', textShadowRadius: 18, textShadowOffset: { width: 0, height: 1 } };

export function HomeScreen({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
}) {
  const { t } = useTranslation();
  const { user, logOut } = useAuth();
  const insets = useSafeAreaInsets();
  const { isDesktop } = useLayout();
  const [employee, setEmployee] = useState<EmployeeDoc | null>(null);
  const [loans, setLoans] = useState<LoanDoc[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const [companionOpen, setCompanionOpen] = useState(false);

  const uid = user?.uid;
  useEffect(() => {
    if (!uid) return;
    setStatus('loading');
    // onSnapshot WITH an error callback, always — a permission error or an
    // offline client must land on the error card with a retry, never an
    // infinite spinner.
    const unsubEmployee = onSnapshot(
      doc(db, 'employees', uid),
      (snapshot) => {
        setEmployee((snapshot.data() as EmployeeDoc | undefined) ?? null);
        setStatus('ready');
      },
      () => setStatus('error')
    );
    // The same query the Créditos screen runs — the chip and the pill counts
    // read the real documents, never a summary.
    const unsubLoans = onSnapshot(
      query(collection(db, 'loans'), where('employeeId', '==', uid)),
      (snapshot) => {
        const next = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LoanDoc, 'id'>) }));
        next.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
        setLoans(next);
      },
      () => {}
    );
    return () => {
      unsubEmployee();
      unsubLoans();
    };
  }, [uid, retryToken]);

  const verified = employee?.metamapStatus === 'verified';
  const name = employee?.name || user?.email || '';
  const settling = employee !== null && typeof employee.creditLimit !== 'number';
  const creditLimit = employee?.creditLimit ?? 0;
  const available = employee?.availableCredit ?? creditLimit;
  const active = loans.find(isActiveLoan);
  const activeCount = loans.filter(isActiveLoan).length;
  const paidCount = loans.filter(isPaidLoan).length;

  if (status === 'loading') {
    return (
      <Backdrop variant="leaf">
        <View style={[styles.screen, { paddingTop: insets.top + spacing.l }]}>
          <View style={styles.head}>
            <Skeleton width={70} height={14} radius={radii.pill} style={{ opacity: 0.4 }} />
            <Skeleton width={34} height={34} radius={radii.pill} style={{ opacity: 0.4 }} />
          </View>
          <View style={{ flex: 1 }} />
          <Skeleton width={120} height={14} radius={radii.pill} style={{ opacity: 0.4 }} />
          <Skeleton width={200} height={50} radius={radii.s} style={{ marginTop: spacing.s, opacity: 0.4 }} />
          <Skeleton height={96} radius={radii.m} style={{ marginTop: spacing.l, opacity: 0.4 }} />
          <Skeleton height={54} radius={radii.pill} style={{ marginTop: spacing.l, opacity: 0.4 }} />
        </View>
      </Backdrop>
    );
  }

  if (status === 'error') {
    return (
      <Backdrop variant="paper">
        <View style={styles.center}>
          <Text style={styles.error}>{t('home.loadError')}</Text>
          <PrimaryButton label={t('common.retry')} onPress={() => setRetryToken((n) => n + 1)} />
        </View>
      </Backdrop>
    );
  }

  // Facts only — the companion states what is true of this account. Never a
  // question back to the user, never a figure the documents don't carry.
  const facts: string[] = [];
  if (active) {
    const next = active.repaymentSchedule?.[0];
    const amount = next?.amount ?? totalOf(active);
    const date = next?.dueDate ?? active.dueDate;
    if (typeof amount === 'number' && date) {
      facts.push(t('home.factNextDeduction', { amount: numeral(amount), date: shortDate(date) }));
    }
  }
  if (settling) facts.push(t('home.factSettling'));
  else if (!verified) facts.push(t('home.factVerify'));
  else if (!active && available > 0) facts.push(t('home.factAvailable', { amount: numeral(available) }));
  facts.push(t('home.factLimitRule'));

  const principal = active ? principalOf(active) : undefined;
  const total = active ? totalOf(active) : undefined;
  const paid = active ? paidOf(active) : undefined;
  const ratio = typeof paid === 'number' && typeof total === 'number' && total > 0 ? Math.min(paid / total, 1) : null;
  const remaining = active?.repaymentSchedule?.length ?? (active ? 1 : 0);

  return (
    <Backdrop variant="leaf">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing.l }]}
      >
        <PageColumn maxWidth={isDesktop ? 560 : undefined} style={styles.screen}>
          <FadeSlideIn index={0}>
            <View style={styles.head}>
              <DotLabel color="rgba(244,247,238,0.75)" size={14}>{t('home.label')}</DotLabel>
              <PressableScale onPress={() => void logOut()} accessibilityRole="button" accessibilityLabel={t('common.signOut')}>
                <Avatar initials={initialsOf(String(name))} />
              </PressableScale>
            </View>
          </FadeSlideIn>

          <View style={{ flex: 1, minHeight: spacing.xl * 2 }} />

          <FadeSlideIn index={1}>
            <Text style={[styles.balanceLabel, shadow]}>{t('home.available')}</Text>
            {settling ? (
              <Text style={[styles.settling, shadow]}>{t('home.settling')}</Text>
            ) : (
              <Text style={[styles.balance, shadow]} accessibilityLabel={`${numeral(available)} pesos disponibles`}>
                {numeral(available)}
                <Text style={styles.balanceUnit}> {t('common.mxn')}</Text>
              </Text>
            )}
          </FadeSlideIn>

          {active ? (
            <FadeSlideIn index={2}>
              <PressableScale
                onPress={() => navigation.navigate('Loans', { filter: 'active' })}
                accessibilityRole="button"
                accessibilityLabel={t('home.loanChip', { amount: numeral(principal) })}
              >
                <GlassCard style={{ marginTop: 26 }}>
                  <View style={styles.chipInner}>
                    <View style={styles.chipRow}>
                      <Text style={styles.chipTitle}>{t('home.loanChip', { amount: numeral(principal) })}</Text>
                      <Text style={styles.chipMeta}>{ratio !== null ? `${Math.round(ratio * 100)}%` : shortDate(active.dueDate)}</Text>
                    </View>
                    {ratio !== null ? (
                      <View style={styles.bar}>
                        <TrackFill ratio={ratio} color="#ffffff" height={6} />
                      </View>
                    ) : null}
                    <View style={[styles.chipRow, { marginTop: ratio !== null ? 8 : 10 }]}>
                      <Text style={styles.chipSmall}>
                        {ratio !== null
                          ? t('home.repaidOf', { paid: numeral(paid), total: numeral(total) })
                          : t('home.toRepay', { total: numeral(total) })}
                      </Text>
                      <Text style={styles.chipSmall}>{t('home.paymentsLeft', { count: remaining })}</Text>
                    </View>
                  </View>
                </GlassCard>
              </PressableScale>
            </FadeSlideIn>
          ) : null}

          <FadeSlideIn index={3}>
            <LinearGradient colors={assistGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.companion}>
              <View style={styles.chipRow}>
                <DotLabel color="rgba(20,40,20,0.55)" size={14}>{t('home.companion')}</DotLabel>
                <PressableScale
                  onPress={() => setCompanionOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: companionOpen }}
                  style={styles.expand}
                >
                  <Ionicons name={companionOpen ? 'remove' : 'add'} size={14} color={colors.ink} />
                </PressableScale>
              </View>
              <View style={styles.facts}>
                {(companionOpen ? facts : facts.slice(0, 2)).map((f) => (
                  <View key={f} style={styles.fact}>
                    <Text style={styles.factText}>{f}</Text>
                  </View>
                ))}
              </View>
            </LinearGradient>
          </FadeSlideIn>

          <FadeSlideIn index={4}>
            <View style={styles.pills}>
              <Pill label={t('home.filterAll')} active count={loans.length} onLeaf onPress={() => navigation.navigate('Loans', { filter: 'all' })} />
              <Pill label={t('home.filterActive')} onLeaf onPress={() => navigation.navigate('Loans', { filter: 'active' })} testID="home-active" />
              <Pill label={t('home.filterPaid')} onLeaf onPress={() => navigation.navigate('Loans', { filter: 'paid' })} />
              {activeCount + paidCount > 0 ? null : null}
            </View>
          </FadeSlideIn>

          {/* The one action. Ink pill, green only in the dot that marks it. */}
          <FadeSlideIn index={5}>
            <PressableScale
              onPress={() => (verified ? navigation.navigate('RequestLoan') : void Linking.openURL('https://funpay.mx'))}
              disabled={settling}
              accessibilityRole="button"
              accessibilityLabel={verified ? t('home.requestCta') : t('home.verifyCta')}
              style={[styles.fund, settling && { opacity: 0.45 }]}
              testID="home-request"
            >
              <View style={styles.fundDot}>
                <Ionicons name={verified ? 'arrow-up' : 'shield-checkmark'} size={16} color={colors.ink} />
              </View>
              <Text style={styles.fundText}>{verified ? t('home.requestCta') : t('home.verifyCta')}</Text>
            </PressableScale>
            {!verified && !settling ? <Text style={[styles.note, shadow]}>{t('home.verifyNote')}</Text> : null}
          </FadeSlideIn>
        </PageColumn>
      </ScrollView>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, paddingHorizontal: 28, paddingBottom: 28 },
  screen: { flex: 1, minHeight: 640 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  balanceLabel: { fontFamily: fonts.sansLight, fontSize: 15, color: ON_LEAF, opacity: 0.9 },
  balance: { fontFamily: fonts.sans, fontSize: type.numeral, letterSpacing: -1.5, lineHeight: 54, color: ON_LEAF, marginTop: 4, fontVariant: ['tabular-nums'] },
  balanceUnit: { fontFamily: fonts.sansLight, fontSize: 20, letterSpacing: 0, color: ON_LEAF, opacity: 0.7 },
  settling: { fontFamily: fonts.sans, fontSize: 22, color: ON_LEAF, marginTop: 6 },
  chipInner: { padding: 16, paddingBottom: 14 },
  chipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chipTitle: { fontFamily: fonts.sansBold, fontSize: 15, color: ON_LEAF },
  chipMeta: { fontFamily: fonts.sans, fontSize: 15, color: ON_LEAF, opacity: 0.75 },
  bar: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', marginTop: 12, overflow: 'hidden' },
  chipSmall: { fontFamily: fonts.sans, fontSize: 12.5, color: ON_LEAF, opacity: 0.8 },
  companion: { marginTop: 18, padding: 12, borderRadius: radii.m, ...shadowFloat },
  expand: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.55)', alignItems: 'center', justifyContent: 'center' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14, marginBottom: 2 },
  fact: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.64)' },
  factText: { fontFamily: fonts.sans, fontSize: 11.5, color: colors.inkSoft },
  pills: { flexDirection: 'row', gap: 6, marginTop: 22, flexWrap: 'wrap' },
  fund: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.ink,
    borderRadius: radii.pill,
    padding: 6,
    paddingRight: 20,
    alignSelf: 'flex-start',
  },
  fundDot: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.cta, alignItems: 'center', justifyContent: 'center' },
  fundText: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.cream },
  note: { fontFamily: fonts.sans, fontSize: 12.5, color: ON_LEAF, opacity: 0.85, marginTop: 10, lineHeight: 18 },
  error: { fontFamily: fonts.sans, color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
