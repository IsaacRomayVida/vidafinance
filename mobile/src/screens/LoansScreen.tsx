import { collection, onSnapshot, query, where } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { fetchPaymentUrl } from '../api/callables';
import { useAuth } from '../hooks/useAuth';
import { db } from '../lib/firebase';
import { isPayableStatus, statusLabelKey } from '../lib/loanStatus';
import { formatDate, formatMxn } from '../lib/money';
import { colors, spacing } from '../theme';

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

export function LoansScreen() {
  const { t } = useTranslation();
  const { user } = useAuth();
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
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{t('loans.loadError')}</Text>
        <Pressable style={styles.payButton} onPress={() => setRetryToken((n) => n + 1)}>
          <Text style={styles.payButtonText}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.l }}
      data={loans}
      keyExtractor={(loan) => loan.id}
      ListEmptyComponent={<Text style={styles.empty}>{t('loans.empty')}</Text>}
      ListHeaderComponent={payError ? <Text style={styles.error}>{payError}</Text> : null}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.cardTop}>
            <Text style={styles.amount}>{formatMxn(item.principalAmount ?? item.amount)}</Text>
            <View style={styles.chip}>
              <Text style={styles.chipText}>{t(statusLabelKey(item.status))}</Text>
            </View>
          </View>
          <Text style={styles.meta}>
            {t('loans.total')}: {formatMxn(item.totalRepaymentAmount ?? item.total)}
          </Text>
          <Text style={styles.meta}>
            {t('loans.requested')}: {formatDate(item.createdAt)}
          </Text>
          {isPayableStatus(item.status) ? (
            <Pressable
              style={[styles.payButton, payingId === item.id && styles.payButtonDisabled]}
              onPress={() => void pay(item.id)}
              disabled={payingId !== null}
            >
              <Text style={styles.payButtonText}>
                {payingId === item.id ? t('loans.paying') : t('loans.pay')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.l },
  empty: { color: colors.subtle, textAlign: 'center', marginTop: spacing.xl },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { fontSize: 22, fontWeight: '700', color: colors.text },
  chip: { backgroundColor: colors.chipBg, borderRadius: 999, paddingHorizontal: spacing.m, paddingVertical: spacing.xs },
  chipText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
  meta: { color: colors.subtle, fontSize: 14, marginTop: spacing.xs },
  payButton: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.m,
  },
  payButtonDisabled: { opacity: 0.6 },
  payButtonText: { color: colors.primaryText, fontSize: 15, fontWeight: '600' },
  error: { color: colors.danger, marginBottom: spacing.m, textAlign: 'center' },
});
