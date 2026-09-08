/**
 * The FunPay icon set — drawn, not generated.
 *
 * One 24-unit grid, 1.4 stroke, round caps and joins, no fills except where
 * a shape must read as solid at 20px. Every icon is a single object seen
 * flat-on: the things in the operation (a payroll envelope, a quincena, an
 * employer, a contract) rather than illustrations of them. They inherit
 * `currentColor`, so the same icon works on cream and on the dark board.
 */
import type { CSSProperties, ReactElement } from 'react';

export type IconName =
  | 'nomina'
  | 'quincena'
  | 'empleador'
  | 'condusef'
  | 'sat'
  | 'cobranza'
  | 'contrato'
  | 'adelanto'
  | 'kyc'
  | 'reporte';

const PATHS: Record<IconName, ReactElement> = {
  // Payroll envelope, flap open, a note inside.
  nomina: (
    <>
      <rect x="3" y="6.5" width="18" height="12" rx="2.5" />
      <path d="M6.5 6.5V4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v2" />
      <path d="M3 8.8l8.2 5a1.5 1.5 0 0 0 1.6 0l8.2-5" />
    </>
  ),
  // A quincena: the fortnight, with the payday marked.
  quincena: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M8 3v4M16 3v4" />
      <circle cx="16" cy="15.5" r="1.9" fill="currentColor" stroke="none" />
      <path d="M7 13.5h4M7 17.5h3" />
    </>
  ),
  // The employer: a building, seen straight on.
  empleador: (
    <>
      <path d="M4 21V6.2a1 1 0 0 1 .62-.93l7-2.8a1 1 0 0 1 1.38.93V21" />
      <path d="M13 9.5h6.4a1 1 0 0 1 1 1V21" />
      <path d="M2.5 21h19" />
      <path d="M7 8.5h2.5M7 12h2.5M7 15.5h2.5M16 13h1.5M16 16.5h1.5" />
    </>
  ),
  // Consumer protection: a shield with a check.
  condusef: (
    <>
      <path d="M12 3l7 2.6v5.9c0 4.4-2.9 8.3-7 9.5-4.1-1.2-7-5.1-7-9.5V5.6L12 3z" />
      <path d="M9 12.2l2.1 2.1L15.4 10" />
    </>
  ),
  // The tax receipt: a folded slip with a stamp.
  sat: (
    <>
      <path d="M5.5 3.5h13v17l-2.2-1.4-2.2 1.4-2.1-1.4-2.2 1.4-2.1-1.4-2.2 1.4v-17z" />
      <path d="M9 8h6M9 11.5h6M9 15h3.5" />
    </>
  ),
  // Collections: coins, one in front.
  cobranza: (
    <>
      <ellipse cx="12" cy="6.4" rx="7" ry="3" />
      <path d="M5 6.4v5.2c0 1.7 3.1 3 7 3s7-1.3 7-3V6.4" />
      <path d="M5 11.6v5.2c0 1.7 3.1 3 7 3s7-1.3 7-3v-5.2" />
    </>
  ),
  // The agreement: a page with a signature line.
  contrato: (
    <>
      <path d="M6 3h8.2L19 7.6V21H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 16.5c1.2-1.6 2-1.6 2.6 0 .6 1.6 1.4 1.6 2.6 0" />
      <path d="M9 11.5h6" />
    </>
  ),
  // The advance: money moving up, out of the line.
  adelanto: (
    <>
      <rect x="3" y="7" width="18" height="12" rx="2.5" />
      <path d="M3 11h18" />
      <path d="M12 17.5v-5M9.8 14.4L12 12.2l2.2 2.2" />
    </>
  ),
  // Identity: the card, with the photo panel.
  kyc: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="8.8" cy="11" r="2.1" />
      <path d="M5.6 16.2c.5-1.5 1.7-2.3 3.2-2.3s2.7.8 3.2 2.3" />
      <path d="M15 10h3.5M15 13.5h3.5" />
    </>
  ),
  // The report handed back: a page with a rising line.
  reporte: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7.5 15.2l3-3.4 2.4 2.2 3.6-4.4" />
      <path d="M7.5 8h4" />
    </>
  ),
};

export function Icon({
  name,
  size = 24,
  style,
  className,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}
