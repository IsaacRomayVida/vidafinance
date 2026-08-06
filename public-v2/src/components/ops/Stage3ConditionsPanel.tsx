/**
 * Stage 3 — Condiciones de auto-aprobación (E5c).
 *
 * The screen that answers "which check failed, on what value, against what
 * bound". `getReviewDetail` has returned the full breakdown since #583 and
 * nothing rendered it, so a reviewer approving a real loan was reading a
 * verdict without its evidence.
 *
 * All grouping lives in lib/underwritingConditions.ts. This file decides only
 * how a row reads, and two of those decisions are load-bearing:
 *
 *   - No red/green. A failed condition is an input to a pending decision, not
 *     the decision. `--danger` here would let "the evaluator flagged this" be
 *     read as "the loan was rejected". Failure is carried by weight, an icon
 *     and a left accent bar instead (CTO ruling, 2026-08-06).
 *   - One "something is missing" indicator per row. A row whose value was never
 *     read gets the dash icon and the provenance badge, and does not also get
 *     the `✕` — two markers competing for the same fact read as two problems.
 */
import {
  bucketConditions,
  classifyCondition,
  conditionHint,
  formatConditionValue,
  hasReadableValue,
  isNearThreshold,
  sourceBadge,
  type UnderwritingConditionRow,
  type UnderwritingDetail,
} from '../../lib/underwritingConditions';

const PANEL_TITLE = 'Etapa 3 — Condiciones de auto-aprobación';

/* ── styles ────────────────────────────────────────────────────────────────── */

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--t1)',
  letterSpacing: '-0.01em',
};

const summaryStyle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 700,
  color: 'var(--t1)',
  marginTop: 2,
};

const groupHeadingStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '1.4px',
  color: 'var(--t2)',
  marginTop: 18,
  marginBottom: 2,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  // 8px, not the frames' itemSpacing:0 — see the note at the foot of this file.
  gap: 8,
  padding: '11px 0',
  borderBottom: '1px solid rgba(25,68,69,0.06)',
};

/**
 * The failing group's only structural signal, now that colour is off the table.
 * Applied to the whole group rather than per row so that a row inside it cannot
 * read as non-failing because its value happens to be missing.
 */
const failedRowStyle: React.CSSProperties = {
  ...rowStyle,
  borderLeft: '3px solid var(--t1)',
  paddingLeft: 14,
};

const iconStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1,
  width: 12,
  flexShrink: 0,
};

const metaStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: 'var(--t2)',
};

/**
 * Tags, badges and hints share one scale so no annotation outranks another.
 *
 * `--t2`, never `--t3`: #93aaa9 is 2.45:1 on white, under AA for body text and
 * under even the 3:1 floor for non-text UI. None of these is a regulated
 * disclosure that would earn the carve-out.
 */
const annotationStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--t2)',
};

/* ── rows ──────────────────────────────────────────────────────────────────── */

/**
 * `✕` only for a condition that was actually tested and actually failed.
 *
 * A row with no value never gets it, whichever group it is in: the `–` says
 * "nothing was read here", which is a different statement from "this was
 * measured and it is wrong", and the panel is worth nothing if a reviewer
 * cannot tell those apart at a glance.
 */
function rowIcon(row: UnderwritingConditionRow): string {
  if (classifyCondition(row) === 'passed') return '✓';
  return row.pass === false && hasReadableValue(row) ? '✕' : '–';
}

function ConditionRow({
  row,
  failed,
  showAnnotations,
}: {
  row: UnderwritingConditionRow;
  failed: boolean;
  /** False in the all-pass view, where no row is being singled out. */
  showAnnotations: boolean;
}) {
  const icon = rowIcon(row);
  const badge = sourceBadge(row);
  const near = showAnnotations && isNearThreshold(row);

  // Only where the distance is the point. A row that cleared its bound by half
  // does not need "1 punto bajo el límite" attached to it — that reads as a
  // caveat on a condition nobody has a question about, and twelve of them
  // bury the two rows that do.
  const hint = showAnnotations && (failed || near) ? conditionHint(row) : null;

  // One slot for "read this row differently", so a badge and a near-limit tag
  // can never stack up beside the same name.
  const tag = badge ?? (near ? 'cerca del límite' : null);

  return (
    <div style={failed ? failedRowStyle : rowStyle}>
      <span style={{ ...iconStyle, color: icon === '✕' ? 'var(--t1)' : 'var(--t2)' }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: failed ? 700 : 400, color: 'var(--t1)' }}>
        {row.name?.trim() || '—'}
      </span>
      {tag ? <span style={annotationStyle}>{tag}</span> : null}
      <span style={{ ...metaStyle, fontWeight: failed ? 700 : 400 }}>
        Valor: {formatConditionValue(row.value)}
      </span>
      <span style={metaStyle}>
        {/* Verbatim from the backend: reformatting a bound is how the panel
            would start disagreeing with the gate that applied it. */}
        · Requerido: {row.required?.trim() || '—'}
      </span>
      {hint ? <span style={annotationStyle}>{hint}</span> : null}
    </div>
  );
}

function ConditionGroup({
  heading,
  rows,
  failed = false,
}: {
  heading: string;
  rows: UnderwritingConditionRow[];
  failed?: boolean;
}) {
  // An empty group renders nothing at all — not a heading with a zero beside
  // it. A 12/12 loan should not have to explain the checks it did not trip.
  if (rows.length === 0) return null;
  return (
    <>
      <div style={groupHeadingStyle}>{heading}</div>
      {rows.map((row, i) => (
        <ConditionRow key={row.id ?? `row-${i}`} row={row} failed={failed} showAnnotations />
      ))}
    </>
  );
}

/* ── panel ─────────────────────────────────────────────────────────────────── */

export function Stage3ConditionsPanel({
  detail,
  cardStyle,
}: {
  detail: UnderwritingDetail | null;
  cardStyle: React.CSSProperties;
}) {
  const buckets = bucketConditions(detail);

  // 12px, overriding the page's 20px cards, per CTO ruling 2026-08-06 (§5 of
  // the production notes): the already-approved conditions panel is 12px and a
  // second radius convention should not arrive mid-project.
  const panelStyle: React.CSSProperties = { ...cardStyle, borderRadius: 12 };

  /* Empty state. A loan that never reached Stage 3, one predating #393/#509,
     or a review with no loanId all land here, and none of them is an error.
     This replaces the panel only — the Acciones bar below it stays live. */
  if (buckets.total === 0) {
    return (
      <div style={panelStyle}>
        <div style={titleStyle}>{PANEL_TITLE}</div>
        <div style={{ ...iconStyle, color: 'var(--t2)', margin: '14px 0 8px' }}>–</div>
        <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6, maxWidth: 700 }}>
          Sin evaluación registrada — este préstamo no llegó a la etapa 3 de evaluación automática
          (rechazo temprano) o se creó antes de que el desglose de condiciones se empezara a
          guardar.
        </p>
      </div>
    );
  }

  /* All-pass. A flat list, because at 12/12 the passing rows ARE the panel:
     collapsing them would leave an empty card, and grouping them would need
     headings for groups that do not exist. Nothing is singled out here, so no
     near-limit tags either — a caveat needs something to be a caveat against. */
  if (buckets.allPass) {
    return (
      <div style={panelStyle}>
        <div style={titleStyle}>{PANEL_TITLE}</div>
        <div style={summaryStyle}>
          {buckets.total} de {buckets.total} condiciones cumplidas
        </div>
        <div style={{ marginTop: 14 }}>
          {buckets.passed.map((row, i) => (
            <ConditionRow
              key={row.id ?? `row-${i}`}
              row={row}
              failed={false}
              showAnnotations={false}
            />
          ))}
        </div>
      </div>
    );
  }

  // Every count comes off the array. The gate wrote 10 rows before #583 and
  // will write another number eventually; a literal here would quietly become
  // a lie about a document nobody re-read.
  const clauses = [
    buckets.failed.length > 0 ? `${buckets.failed.length} de ${buckets.total} no cumplen` : null,
    buckets.near.length > 0 ? `${buckets.near.length} cerca del límite` : null,
    buckets.unevaluated.length > 0 ? `${buckets.unevaluated.length} sin evaluar` : null,
  ].filter(Boolean);

  const metCount = buckets.met.length;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>{PANEL_TITLE}</div>
      <div style={summaryStyle}>{clauses.join(' · ')}</div>

      <ConditionGroup heading={`NO CUMPLEN (${buckets.failed.length})`} rows={buckets.failed} failed />
      <ConditionGroup
        heading={`CERCA DEL LÍMITE (${buckets.near.length} — pasan, pero ajustadas)`}
        rows={buckets.near}
      />
      <ConditionGroup heading={`SIN EVALUAR (${buckets.unevaluated.length})`} rows={buckets.unevaluated} />

      {metCount > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary
            style={{
              fontSize: 13,
              color: 'var(--t1)',
              cursor: 'pointer',
              fontWeight: 600,
              listStyle: 'none',
            }}
          >
            ▼ {metCount} {metCount === 1 ? 'condición cumplida' : 'condiciones cumplidas'}
          </summary>
          <div style={{ marginTop: 8 }}>
            {buckets.met.map((row, i) => (
              <ConditionRow key={row.id ?? `row-${i}`} row={row} failed={false} showAnnotations />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/*
 * Inherited row layout — read before "fixing" the spacing.
 *
 * The approved frames lay each row out with `itemSpacing: 0`, which renders as
 * "Score de buróValor: 580Requerido: > 600" with the sub-fields run together.
 * Production note #4 records that as pre-existing in node 30:125 and probably
 * unintentional, and this ticket is explicitly not the place to redesign row
 * internals — so the structure here is the frames' structure, field for field
 * and slot for slot.
 *
 * The one thing not reproduced is the zero gap itself. In Figma that setting
 * leaves text touching; in HTML it leaves text concatenated, which is not a
 * cramped design but an unreadable one. The 8px gap in `rowStyle` is the
 * minimum that keeps the words apart. Row internals stay open as the separate
 * polish item the note asks for.
 */
