/**
 * satBlacklistRefresh.ts — VID3-714
 *
 * Self-hosts SAT's two public "blacklist" datasets so underwriting-service
 * can perform EFOS (Lista 69-B) + Art. 69 screening without the paid SW
 * SAPiens integration. SAT publishes both as CSVs on omawww.sat.gob.mx and
 * the files are updated roughly monthly.
 *
 *   EFOS (Lista 69-B)  — ~12k RFCs flagged for tax fraud. Source of truth
 *                        for the hardReject-on-DEFINITIVO rule.
 *   Art. 69            — ~500-800k RFCs with outstanding fiscal debt.
 *                        Any hit = reject at stage-a.
 *
 * This function:
 *   1. Downloads both CSVs (HTTP)
 *   2. Decodes Windows-1252 -> UTF-8 (SAT files are not UTF-8)
 *   3. Parses + normalizes to { [rfc]: {...} } maps for O(1) lookup
 *   4. Writes sat/efos.json + sat/art69.json to the default GCS bucket
 *   5. Writes sat_refresh_meta/latest to Firestore with counts, sizes,
 *      parse failure rate, durations, and source URLs for ops visibility.
 *
 * If >5% of rows in either file fail the RFC regex we abort (almost
 * certainly a schema change from SAT) and alert Slack. The underwriting
 * sat-blacklist-client reads the last-good blob from GCS and will keep
 * functioning on stale data until the refresh succeeds again.
 *
 * Exposed as both:
 *   - onSchedule  — 15th of each month at 02:00 America/Mexico_City
 *   - onCall      — admin-only manual trigger for bootstrap + ad-hoc refresh
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import fetch from 'node-fetch';

import { sendSlackAlert } from '../utils/slackAlert';

// ── Canonical public URLs ───────────────────────────────────────────────
// These are stable SAT-published endpoints; the underlying file is
// overwritten each publication cycle. Override via env if SAT restructures.
const DEFAULT_EFOS_URL =
  'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv';
const DEFAULT_ART69_URL =
  'http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69.csv';

const GCS_EFOS_PATH = 'sat/efos.json';
const GCS_ART69_PATH = 'sat/art69.json';
const META_COLLECTION = 'sat_refresh_meta';
const META_DOC_ID = 'latest';

const MAX_PARSE_FAILURE_RATE = 0.05; // abort if >5% of rows drop on RFC validation
const DOWNLOAD_TIMEOUT_MS = 120_000; // Art.69 is ~60MB

// RFC: 3-4 letters (including & and Ñ for legacy moral RFCs) + 6 digits + 3 alphanumerics
const RFC_REGEX = /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/;

// ── Types ───────────────────────────────────────────────────────────────
export interface EfosEntry {
  rfc: string;
  nombre: string;
  situacion: string;
}

export interface Art69Entry {
  rfc: string;
  nombre: string;
  tipo_adeudo: string;
  monto: string;
}

export interface RefreshStats {
  efosCount: number;
  art69Count: number;
  efosSource: string;
  art69Source: string;
  efosSizeBytes: number;
  art69SizeBytes: number;
  efosParseFailureRate: number;
  art69ParseFailureRate: number;
  lastRun: string;
  durationMs: number;
}

// ── CSV parsing ─────────────────────────────────────────────────────────
/**
 * Minimal tolerant CSV parser. Handles:
 *   - UTF-8 BOM on first line
 *   - CRLF / LF line endings
 *   - Double-quoted fields with embedded commas + escaped quotes ("")
 *   - Header row with mixed case and spaces (lowercased + snake_cased)
 * SAT CSVs are well-formed enough that we don't need a full RFC 4180 parser.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const stripped = text.replace(/^\uFEFF/, '');
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const splitRow = (row: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        if (inQuotes && row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };

  const header = splitRow(lines[0]).map((h) =>
    h.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  );
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((name, idx) => {
      row[name] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/** Decode a Buffer as Windows-1252 (SAT CSVs are Latin-1-family, not UTF-8). */
export function decodeLatin1(buf: Buffer): string {
  return new TextDecoder('windows-1252').decode(buf);
}

function findColumn(row: Record<string, string>, patterns: RegExp[]): string {
  for (const p of patterns) {
    for (const key of Object.keys(row)) {
      if (p.test(key)) return key;
    }
  }
  return '';
}

// ── Normalizers ─────────────────────────────────────────────────────────
export function normalizeEfos(
  rows: Array<Record<string, string>>
): Record<string, EfosEntry> {
  const out: Record<string, EfosEntry> = {};
  for (const row of rows) {
    const rfcKey = findColumn(row, [/^rfc$/, /rfc/]);
    const rfc = (row[rfcKey] || '').trim().toUpperCase();
    if (!RFC_REGEX.test(rfc)) continue;

    const nombreKey = findColumn(row, [/nombre_del_contribuyente/, /^nombre$/, /nombre/]);
    const situacionKey = findColumn(row, [/^situacion$/, /situacion/]);

    out[rfc] = {
      rfc,
      nombre: (row[nombreKey] || '').trim(),
      situacion: (row[situacionKey] || '').trim().toUpperCase(),
    };
  }
  return out;
}

export function normalizeArt69(
  rows: Array<Record<string, string>>
): Record<string, Art69Entry> {
  const out: Record<string, Art69Entry> = {};
  for (const row of rows) {
    const rfcKey = findColumn(row, [/^rfc$/, /rfc/]);
    const rfc = (row[rfcKey] || '').trim().toUpperCase();
    if (!RFC_REGEX.test(rfc)) continue;

    const nombreKey = findColumn(row, [/nombre_del_contribuyente/, /^nombre$/, /nombre/]);
    const tipoKey = findColumn(row, [/tipo.*adeudo/, /tipo.*deuda/, /supuesto/]);
    const montoKey = findColumn(row, [/^monto$/, /monto/, /importe/]);

    out[rfc] = {
      rfc,
      nombre: (row[nombreKey] || '').trim(),
      tipo_adeudo: (row[tipoKey] || '').trim(),
      monto: (row[montoKey] || '').trim(),
    };
  }
  return out;
}

// ── Download + persistence ──────────────────────────────────────────────
async function downloadCsv(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url, {
    timeout: DOWNLOAD_TIMEOUT_MS,
    headers: { 'User-Agent': 'vida-finance-sat-refresh/1.0' },
  });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function writeJsonToBucket(path: string, payload: unknown): Promise<number> {
  const bucket = getStorage().bucket();
  const data = Buffer.from(JSON.stringify(payload));
  const file = bucket.file(path);
  await file.save(data, {
    contentType: 'application/json',
    resumable: false,
  });
  return data.length;
}

// ── Core logic ──────────────────────────────────────────────────────────
export interface PerformRefreshOptions {
  efosUrl?: string;
  art69Url?: string;
}

export async function performRefresh(
  opts: PerformRefreshOptions = {}
): Promise<RefreshStats> {
  const start = Date.now();
  const efosUrl = opts.efosUrl || process.env['SAT_EFOS_URL'] || DEFAULT_EFOS_URL;
  const art69Url = opts.art69Url || process.env['SAT_ART69_URL'] || DEFAULT_ART69_URL;

  const [efosBuf, art69Buf] = await Promise.all([
    downloadCsv(efosUrl, 'EFOS'),
    downloadCsv(art69Url, 'Art.69'),
  ]);

  const efosRows = parseCsv(decodeLatin1(efosBuf));
  const art69Rows = parseCsv(decodeLatin1(art69Buf));

  const efosNormalized = normalizeEfos(efosRows);
  const art69Normalized = normalizeArt69(art69Rows);

  const efosCount = Object.keys(efosNormalized).length;
  const art69Count = Object.keys(art69Normalized).length;

  const efosFailureRate =
    efosRows.length > 0 ? 1 - efosCount / efosRows.length : 0;
  const art69FailureRate =
    art69Rows.length > 0 ? 1 - art69Count / art69Rows.length : 0;

  if (efosFailureRate > MAX_PARSE_FAILURE_RATE) {
    throw new Error(
      `EFOS parse failure rate too high: ${(efosFailureRate * 100).toFixed(
        1
      )}% of ${efosRows.length} rows — likely SAT schema change`
    );
  }
  if (art69FailureRate > MAX_PARSE_FAILURE_RATE) {
    throw new Error(
      `Art. 69 parse failure rate too high: ${(art69FailureRate * 100).toFixed(
        1
      )}% of ${art69Rows.length} rows — likely SAT schema change`
    );
  }

  const generatedAt = new Date().toISOString();

  const [efosSize, art69Size] = await Promise.all([
    writeJsonToBucket(GCS_EFOS_PATH, {
      generatedAt,
      source: efosUrl,
      rows: efosNormalized,
    }),
    writeJsonToBucket(GCS_ART69_PATH, {
      generatedAt,
      source: art69Url,
      rows: art69Normalized,
    }),
  ]);

  const stats: RefreshStats = {
    efosCount,
    art69Count,
    efosSource: efosUrl,
    art69Source: art69Url,
    efosSizeBytes: efosSize,
    art69SizeBytes: art69Size,
    efosParseFailureRate: efosFailureRate,
    art69ParseFailureRate: art69FailureRate,
    lastRun: generatedAt,
    durationMs: Date.now() - start,
  };

  const db = getFirestore();
  await db.collection(META_COLLECTION).doc(META_DOC_ID).set({
    ...stats,
    status: 'ok',
  });

  return stats;
}

async function performRefreshWithAlerting(): Promise<RefreshStats> {
  try {
    const stats = await performRefresh();
    logger.info('SAT blacklist refresh complete', {
      efosCount: stats.efosCount,
      art69Count: stats.art69Count,
      durationMs: stats.durationMs,
      efosSizeBytes: stats.efosSizeBytes,
      art69SizeBytes: stats.art69SizeBytes,
    });
    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('SAT blacklist refresh failed', { error: msg });
    try {
      const db = getFirestore();
      await db
        .collection(META_COLLECTION)
        .doc(META_DOC_ID)
        .set(
          {
            status: 'failed',
            error: msg,
            lastRun: new Date().toISOString(),
          },
          { merge: true }
        );
    } catch (_) {
      // best-effort — if Firestore is down the Slack alert is the next line
    }
    await sendSlackAlert(
      `SAT blacklist refresh failed: ${msg}`,
      'critical'
    ).catch(() => {});
    throw err;
  }
}

// ── Exported handlers ───────────────────────────────────────────────────
export const satBlacklistRefresh = onSchedule(
  {
    schedule: '0 2 15 * *',
    timeZone: 'America/Mexico_City',
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async () => {
    await performRefreshWithAlerting();
  }
);

/**
 * Manual trigger (admin-only). Used to:
 *  - Bootstrap the initial data without waiting for the 15th
 *  - Re-ingest on demand after SAT publishes a hotfix list
 *  - Debug after a scheduled failure
 *
 * Typical call from a Firebase Admin SDK shell:
 *   const { getFunctions, httpsCallable } = require('firebase/functions');
 *   await httpsCallable(getFunctions(), 'refreshSatBlacklists')();
 */
export const refreshSatBlacklists = onCall(
  {
    cors: true,
    enforceAppCheck: false,
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (request): Promise<RefreshStats> => {
    const token = (request.auth?.token ?? {}) as Record<string, unknown>;
    const role = token['role'];
    const isAdmin =
      token['admin'] === true || role === 'admin' || role === 'super_admin';
    if (!isAdmin) {
      throw new HttpsError('permission-denied', 'Admin only');
    }
    return performRefreshWithAlerting();
  }
);
