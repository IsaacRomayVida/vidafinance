import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

import {
  DEFAULT_REMITTANCE_GRACE_DAYS,
  INCIDENT_LOG_COLLECTION,
  PAYROLL_REMITTANCES_COLLECTION,
  REMITTANCE_ALERT_SOURCE,
  calendarDaysBefore,
  overdueAlertEpochOf,
  remittanceAging,
  remittanceAlertDocId,
  remittanceAlertThreshold,
  remittancesQuery,
  resolvedAlertFields,
  todayInMexicoCity,
  type RemittanceAlertResolution,
  type RemittancePosition,
} from '../payroll/remittanceLedger';

export { INCIDENT_LOG_COLLECTION, REMITTANCE_ALERT_SOURCE, remittanceAlertDocId };
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
 * ONE ALERT PER RECORD PER THRESHOLD PER CYCLE. Thresholds are the
 * aging-bucket edges (1, 16 and 31 days overdue). The alert's document id is
 * derived from the batch, the record's alert cycle and the threshold and
 * written with `create()`, so a second run the same day, a retried run, or two
 * overlapping runs cannot raise it twice — and a dismissed alert stays
 * dismissed, because the document is still there. A record first seen already
 * past several thresholds gets one alert, for the highest; the lower ones are
 * not back-filled. A cycle ends when the record is settled; if a void (or a
 * retried batch) makes it owe again, a new cycle starts and its thresholds can
 * be raised again (`overdueAlertEpoch`, remittanceLedger.ts).
 *
 * ALERTS CLOSE THEMSELVES. Booking the receipt that settles a record resolves
 * its open alerts in the same transaction (remittance.ts). This check also
 * walks every open remittance alert and resolves the ones whose record is no
 * longer overdue, or has moved on to a later cycle — whatever path settled it.
 *
 * NO SILENT CAP. Each walk stops after MAX_PAGES pages. A run that hits the cap
 * logs an error, raises its own incident and a critical Slack line, and fails,
 * rather than quietly checking only the first part of the ledger.
 *
 * "Overdue" uses DEFAULT_REMITTANCE_GRACE_DAYS, which is a display default and
 * NOT an agreed contractual term (no deadline is stored per employer). The
 * alert says "late by our default", not "in breach".
 */

/** Source of the incident a truncated run raises — not an overdue alert, so the resolve walk leaves it alone. */
export const REMITTANCE_CHECK_TRUNCATED_SOURCE = 'remittance-overdue-check';

export const PAGE_SIZE = 200;
/** 200 × 50 = 10,000 records per walk: far above today's ledger, low enough to bound a runaway run. */
export const MAX_PAGES = 50;

export interface RemittanceOverdueCheckOptions {
  /** Pages each walk may read before it stops and reports itself truncated. */
  maxPages?: number;
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
  /** Open alerts this run closed because their record is no longer overdue (or has moved to a later cycle). */
  resolved: number;
  /** Alerts that could not be written or closed; the run throws after the sweep if this is not 0. */
  failed: number;
  /** A walk stopped at the page cap with more left to read; the run throws after the sweep if true. */
  truncated: boolean;
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // gRPC ALREADY_EXISTS is 6; some layers surface the string form.
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

const pesos = (cents: number) =>
  `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Close the open remittance alerts that no longer describe a late record: the
 * record has nothing outstanding past the grace window any more, or it settled
 * and re-opened since, so the alert belongs to a finished cycle. An alert whose
 * record cannot be found is left open — that is for a person to look at.
 */
async function resolveStaleAlerts(
  db: Firestore,
  today: string,
  graceDays: number,
  maxPages: number,
  result: RemittanceOverdueCheckResult,
): Promise<void> {
  let afterId: string | undefined;
  for (let pages = 0; ; pages++) {
    // Equality filters only, ordered by id: no composite index needed.
    let query = db
      .collection(INCIDENT_LOG_COLLECTION)
      .where('source', '==', REMITTANCE_ALERT_SOURCE)
      .where('resolved', '==', false)
      .orderBy('__name__');
    if (afterId !== undefined) query = query.startAfter(afterId);
    const page = await query.limit(PAGE_SIZE).get();

    for (const alert of page.docs) {
      const batchId = alert.data()['batchId'];
      if (typeof batchId !== 'string' || !batchId) continue;
      try {
        const record = await db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(batchId).get();
        if (!record.exists) continue;
        const data = record.data() ?? {};
        let resolution: RemittanceAlertResolution | null = null;
        if (!remittanceAging(data, today, graceDays).overdue) resolution = 'no-longer-overdue';
        else if (Number(alert.data()['alertEpoch'] ?? 0) < overdueAlertEpochOf(data)) resolution = 'superseded';
        if (resolution === null) continue;
        await alert.ref.update(resolvedAlertFields(resolution, FieldValue.serverTimestamp()));
        result.resolved++;
      } catch (err) {
        // One alert that cannot be closed must not keep the rest open.
        result.failed++;
        logger.error('Remittance overdue alert could not be resolved', {
          alertId: alert.id,
          batchId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const last = page.docs[page.docs.length - 1];
    if (!last || page.docs.length < PAGE_SIZE) return;
    if (pages + 1 >= maxPages) {
      result.truncated = true;
      return;
    }
    afterId = last.id;
  }
}

/** The sweep itself, with the clock passed in so it can be tested at any date. */
export async function runRemittanceOverdueCheck(
  db: Firestore,
  now: Date,
  graceDays: number = DEFAULT_REMITTANCE_GRACE_DAYS,
  options: RemittanceOverdueCheckOptions = {},
): Promise<RemittanceOverdueCheckResult> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const today = todayInMexicoCity(now);
  const result: RemittanceOverdueCheckResult = {
    asOf: today,
    graceDays,
    overdue: 0,
    raised: [],
    alreadyRaised: 0,
    resolved: 0,
    failed: 0,
    truncated: false,
  };

  await resolveStaleAlerts(db, today, graceDays, maxPages, result);

  let after: RemittancePosition | undefined;
  for (let pages = 0; ; pages++) {
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
      const epoch = overdueAlertEpochOf(data);
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
          .doc(remittanceAlertDocId(doc.id, thresholdDays, epoch))
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
            alertEpoch: epoch,
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
    if (pages + 1 >= maxPages) {
      result.truncated = true;
      break;
    }
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

  if (result.truncated) await reportTruncated(db, today, maxPages);

  logger.info('Remittance overdue check', {
    asOf: today,
    graceDays,
    overdue: result.overdue,
    raised: result.raised.length,
    alreadyRaised: result.alreadyRaised,
    resolved: result.resolved,
    failed: result.failed,
    truncated: result.truncated,
  });
  return result;
}

/**
 * A run that stopped at the page cap has not looked at everything, so it says
 * so in every channel ops watches: the log, the Alerts page (one incident per
 * day, however many runs hit it) and Slack.
 */
async function reportTruncated(db: Firestore, today: string, maxPages: number): Promise<void> {
  const limit = maxPages * PAGE_SIZE;
  logger.error('Remittance overdue check stopped at its page cap; part of the ledger was not checked', {
    asOf: today,
    maxPages,
    pageSize: PAGE_SIZE,
  });
  try {
    await db
      .collection(INCIDENT_LOG_COLLECTION)
      .doc(`${REMITTANCE_CHECK_TRUNCATED_SOURCE}_${today}`)
      .create({
        source: REMITTANCE_CHECK_TRUNCATED_SOURCE,
        error:
          `La revisión diaria de remesas vencidas se detuvo en su límite de ${limit} registros: ` +
          'parte del libro no se revisó y puede haber remesas vencidas sin alerta.',
        severity: 'critical',
        asOf: today,
        maxPages,
        pageSize: PAGE_SIZE,
        ts: FieldValue.serverTimestamp(),
        resolved: false,
      });
  } catch (err) {
    if (!isAlreadyExists(err)) {
      logger.error('Remittance overdue check could not record that it was truncated', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await sendSlackAlert(
    `Payroll remittance overdue check stopped at its cap of ${limit} records as of ${today}: ` +
      'part of the ledger was NOT checked. Raise MAX_PAGES or look at why the ledger grew.',
    'critical',
  ).catch(() => {});
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
    if (result.truncated) {
      throw new Error(`remittanceOverdueCheck: stopped at the ${MAX_PAGES}-page cap; part of the ledger was not checked`);
    }
  },
);
