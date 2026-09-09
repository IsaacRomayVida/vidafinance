import type { ReactNode, CSSProperties } from 'react';
import { RichText } from '../shared/RichText';

/**
 * funpay-ui board primitives for the public site. Every marketing section
 * is a board on the --void page: cream→sage gradient by default, `paper`
 * for flat cream, `ink` for the footer/closing tone, `ops` for the
 * charcoal→forest employer board, `leaf` for the CSS-painted botanical
 * surface that stands in for photography.
 */
export type BoardTone = 'grad' | 'paper' | 'sage' | 'ink' | 'ops' | 'leaf';

interface BoardProps {
  tone?: BoardTone;
  /** Doto board title, centred at the top (screen names, never sentences). */
  label?: string;
  id?: string;
  className?: string;
  tight?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}

export function Board({ tone = 'grad', label, id, className, tight, style, children }: BoardProps) {
  const cls = ['mk-board', tone === 'grad' ? '' : tone, tight ? 'tight' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <section id={id} className={cls} style={style}>
      <div className="mk-inner">
        {label && <span className="mk-board-title dot">{label}</span>}
        {children}
      </div>
    </section>
  );
}

interface HeadProps {
  /** Doto kicker above the title. */
  kicker?: string;
  /** Title HTML — `<em>` renders as the quiet, weight-300 line. */
  title: string;
  lead?: string;
  as?: 'h1' | 'h2';
  center?: boolean;
  className?: string;
}

/** Section head: Doto kicker, 40px Urbanist title with a quiet line, optional lead. */
export function BoardHead({ kicker, title, lead, as = 'h2', center, className }: HeadProps) {
  const Tag = as;
  return (
    <header className={`${center ? 'mk-center' : ''} ${className ?? ''}`.trim()}>
      {kicker && <span className="mk-kicker dot">{kicker}</span>}
      <Tag className="mk-title"><RichText html={title} /></Tag>
      {lead && <p className="mk-lead"><RichText html={lead} /></p>}
    </header>
  );
}

interface StatementProps {
  kicker?: string;
  /** Statement HTML — `<em>` is the quiet line. */
  html: string;
  lead?: string;
  center?: boolean;
  children?: ReactNode;
}

/** Page statement: the big alternating ink / quiet headline from the statement board. */
export function Statement({ kicker, html, lead, center, children }: StatementProps) {
  return (
    <div className={center ? 'mk-center' : undefined}>
      {kicker && <span className="mk-kicker dot">{kicker}</span>}
      <h1 className="mk-h1"><RichText html={html} /></h1>
      {lead && <p className="mk-lead"><RichText html={lead} /></p>}
      {children}
    </div>
  );
}

/** Rows of `b` title + description, rendered as paper pills. */
export function Rows({ items, columns }: { items: { title: string; desc: string; initials?: string }[]; columns?: 2 | 3 }) {
  const cls = columns === 3 ? 'mk-grid-3' : columns === 2 ? 'mk-grid-2' : 'mk-rows';
  return (
    <ul className={cls} style={columns ? { listStyle: 'none', margin: 0, padding: 0 } : undefined}>
      {items.map((it, i) => (
        <li key={i} className="mk-row">
          <span className="a" aria-hidden="true">{it.initials ?? String(i + 1).padStart(2, '0')}</span>
          <div className="t">
            <b>{it.title}</b>
            <p><RichText html={it.desc} /></p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Numbers as the copy: value + one-line label, in paper pills. */
export function Figures({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="mk-figs">
      {items.map((it, i) => (
        <div key={i} className="mk-fig">
          <b>{it.value}</b>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Pill steps: number bubble · title + sub · optional value at the right. */
export function PillSteps({ items }: { items: { title: string; sub?: string; value?: string; state?: 'done' | 'now' }[] }) {
  return (
    <ol className="mk-steps">
      {items.map((it, i) => (
        <li key={i} className={`mk-step${it.state ? ` ${it.state}` : ''}`}>
          <span className="d" aria-hidden="true">{it.state === 'done' ? '✓' : i + 1}</span>
          <span className="l">
            {it.title}
            {it.sub && <small>{it.sub}</small>}
          </span>
          {it.value && <span className="v">{it.value}</span>}
        </li>
      ))}
    </ol>
  );
}

export const ArrowIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);
