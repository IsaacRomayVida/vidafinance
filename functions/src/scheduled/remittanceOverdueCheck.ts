import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_REMITTANCE_GRACE_DAYS,
  calendarDaysBefore,
  remittanceAging,
  remittanceAlertThreshold,
  remittancesQuery,
  todayInMexicoCity,
  type RemittancePosition,
} from '../payroll/remittanceLedger';
import { sendSlackAlert } from '../utils/slackAlert';

/**
 * Daily alert for payroll remittances that stay unpaid (E18 follow-up).
 *
 * The ledger knew which batches were overdue, but only when someone opened the
 * ops remittance screen. This raises each one where ops already looks for
 * trouble, reusing the two channels the other monitors use and adding none:
 *
 *  - `incident_log` — the ops Alerts page (`/ops/alerts`) lists it live and ops
 *    dismiss an entry there (the rules let ops flip `resolved`, nothing else).
 *    This is the channel that is guaranteed to exist.
 *  - `sendSlackAlert` — one summary line per run that raised something. It is
 *    a no-op unless `SLACK_WEBHOOK_URL` is set on Functions, exactly as for
 *    every other caller.
 *
 * ONE ALERT PER RECORD PER THRESHOLD. Thresholds are the aging-bucket edges
 * (1, 16 and 31 days overdue). The alert's document id is derived from the
 * batch and the threshold and written with `create()`, so a second run the
 * same day, a retried run, or two overlapping runs cannot raise it twice —
 * and a dismissed alert stays dismissed, because the document is still there.
 * A record first seen already past several thresholds gets one alert, for the
 * highest; the lower ones are not back-filled.
 *
 * "Overdue" uses DEFAULT_REMITTANCE_GRACE_DAYS, which is a display default and
 * NOT an agreed contractual term (no deadline is stored per employer). The
 * alert says "late by our default", not "in breach".
 */

export const REMITTANCE_ALERT_SOURCE = 'remittance-overdue';
export const INCIDENT_LOG_COLLECTION = 'incident_log';

const PAGE_SIZE = 200;

/** Deterministic, so `create()` is the idempotency check. A batch id is a document id already, so it has no `/`. */
export function remittanceAlertDocId(batchId: string, thresholdDays: number): string {
  return `${REMITTANCE_ALERT_SOURCE}_${thresholdDays}d_${batchId}`;
}

export interface RemittanceOverdueAlert {
  batchId: string;
  employerId: string | null;
  thresholdDays: number;
  daysOverdue: number;
  outstandingCents: number;
}

export interface RemittanceOverdueCheckResult {
  asOf: string;
  graceDays: number;
  /** Outstanding records past the grace window that were looked at. */
  overdue: number;
  /** Alerts written by this run. */
  raised: RemittanceOverdueAlert[];
  /** Overdue records whose alert for the current threshold already existed. */
  alreadyRaised: number;
  /** Records whose alert could not be written; the run throws after the sweep if this is not 0. */
  failed: number;
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // gRPC ALREADY_EXISTS is 6; some layers surface the string form.
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

const pesos = (cents: number) =>
  `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The sweep itself, with the clock passed in so it can be tested at any date. */
export async function runRemittanceOverdueCheck(
  db: Firestore,
  now: Date,
  graceDays: number = DEFAULT_REMITTANCE_GRACE_DAYS,
): Promise<RemittanceOverdueCheckResult> {
  const today = todayInMexicoCity(now);
  const result: RemittanceOverdueCheckResult = {
    asOf: today,
    graceDays,
    overdue: 0,
    raised: [],
    alreadyRaised: 0,
    failed: 0,
  };

  let after: RemittancePosition | undefined;
  for (;;) {
    const page = await remittancesQuery(db, {
      outstandingOnly: true,
      periodEndBefore: calendarDaysBefore(today, graceDays),
      after,
    })
      .limit(PAGE_SIZE)
      .get();

    for (const doc of page.docs) {
      const data = doc.data();
      const aging = remittanceAging(data, today, graceDays);
      const thresholdDays = remittanceAlertThreshold(aging.daysOverdue);
      // The query filters on stored fields; the figures decide.
      if (!aging.overdue || thresholdDays === null) continue;
      result.overdue++;

      const employerId = typeof data['employerId'] === 'string' ? data['employerId'] : null;
      const alert: RemittanceOverdueAlert = {
        batchId: doc.id,
        employerId,
        thresholdDays,
        daysOverdue: aging.daysOverdue,
        outstandingCents: aging.outstandingCents,
      };
      try {
        await db
          .collection(INCIDENT_LOG_COLLECTION)
          .doc(remittanceAlertDocId(doc.id, thresholdDays))
          .create({
            source: REMITTANCE_ALERT_SOURCE,
            // `error` is the line the Alerts page prints after the source.
            error:
              `Remesa de nómina vencida: ${employerId ?? 'empleador desconocido'}, lote ${doc.id} — ` +
              `faltan ${pesos(aging.outstandingCents)}, ${aging.daysOverdue} día(s) de atraso ` +
              `(periodo al ${String(data['payPeriodEnd'] ?? '?')}, gracia de ${graceDays} días)`,
            severity: thresholdDays >= 31 ? 'critical' : 'warning',
            batchId: doc.id,
            employerId,
            payPeriodEnd: data['payPeriodEnd'] ?? null,
            expectedCents: Number(data['expectedCents'] ?? 0),
            receivedCents: Number(data['receivedCents'] ?? 0),
            outstandingCents: aging.outstandingCents,
            daysOverdue: aging.daysOverdue,
            thresholdDays,
            graceDays,
            asOf: today,
            ts: FieldValue.serverTimestamp(),
            resolved: false,
          });
        result.raised.push(alert);
      } catch (err) {
        if (isAlreadyExists(err)) {
          result.alreadyRaised++;
        } else {
          // One record that cannot be written must not hide the rest.
          result.failed++;
          logger.error('Remittance overdue alert could not be written', {
            batchId: doc.id,
            thresholdDays,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const last = page.docs[page.docs.length - 1];
    if (!last || page.docs.length < PAGE_SIZE) break;
    after = { payPeriodEnd: String(last.data()['payPeriodEnd'] ?? ''), batchId: last.id };
  }

  if (result.raised.length > 0) {
    const cents = result.raised.reduce((sum, a) => sum + a.outstandingCents, 0);
    const worst = Math.max(...result.raised.map((a) => a.thresholdDays));
    await sendSlackAlert(
      `${result.raised.length} payroll remittance(s) newly overdue or escalated as of ${today}: ` +
        `${pesos(cents)} outstanding. Batches: ${result.raised
          .slice(0, 10)
          .map((a) => `${a.batchId} (${a.daysOverdue}d)`)
          .join(', ')}${result.raised.length > 10 ? ', …' : ''}. See /ops/remittances.`,
      worst >= 31 ? 'critical' : 'warning',
    ).catch(() => {});
  }

  logger.info('Remittance overdue check', {
    asOf: today,
    graceDays,
    overdue: result.overdue,
    raised: result.raised.length,
    alreadyRaised: result.alreadyRaised,
    failed: result.failed,
  });
  return result;
}

export const remittanceOverdueCheck = onSchedule(
  // After dailyLoanCheck (09:00), so the two daily sweeps do not start together.
  { schedule: '30 9 * * *', timeZone: 'America/Mexico_City' },
  async () => {
    const result = await runRemittanceOverdueCheck(getFirestore(), new Date(Date.now()));
    // Thrown after the sweep so the run shows as failed (and is retried by the
    // next day's run at the latest) without abandoning the records after it.
    if (result.failed > 0) {
      throw new Error(`remittanceOverdueCheck: ${result.failed} alert(s) could not be written`);
    }
  },
);
