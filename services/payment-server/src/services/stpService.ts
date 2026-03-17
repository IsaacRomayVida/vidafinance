import axios from 'axios';
import forge from 'node-forge';
import { admin, db } from '../lib/firebase';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StpSpeiOrder {
  empresa: string;
  folioOrigen: string;
  causaDevolucion: string;
  cuenta: string;
  rfcCurpBeneficiario: string;
  nombreBeneficiario: string;
  conceptoPago: string;
  monto: number;
  tipoPago: number;
  topologia: string;
  medioEntrega: number;
  prioridad: number;
  iva: number;
  claveRastreo?: string;
  tipoCuentaOrdenante?: number;
  nombreOrdenante?: string;
  cuentaOrdenante?: string;
  rfcCurpOrdenante?: string;
  referenciaNumerica?: number;
  tipoCuentaBeneficiario?: number;
}

export interface DisburseSPEIParams {
  loanId: string;
  userId: string;
  amount: number;
  clabe: string;
  beneficiaryName: string;
}

export interface DisburseSPEIResult {
  stpId: string | number;
  folioOrigen: string;
}

// ── RSA-SHA256 Signing with node-forge ───────────────────────────────────────

/**
 * Build the pipe-delimited cadena string that STP requires to be signed.
 * Field order must match STP's ordenaPago specification exactly.
 */
export function buildCadena(order: StpSpeiOrder): string {
  const fields = [
    '',
    order.empresa,
    order.folioOrigen,
    order.claveRastreo ?? '',
    order.tipoCuentaOrdenante ?? '',
    order.nombreOrdenante ?? '',
    order.cuentaOrdenante ?? '',
    order.rfcCurpOrdenante ?? '',
    order.monto,
    order.nombreBeneficiario,
    order.cuenta,
    order.rfcCurpBeneficiario,
    order.conceptoPago,
    order.referenciaNumerica ?? 0,
    order.tipoPago,
    order.topologia,
    order.iva,
    order.prioridad,
    order.tipoCuentaBeneficiario ?? '',
    '',
  ];
  return `|${fields.join('|')}`;
}

/**
 * Sign a STP order using RSA-SHA256 via node-forge.
 * Returns the base64-encoded signature for the `firma` field.
 */
export function signOrder(order: StpSpeiOrder, privateKeyPem: string): string {
  const cadena = buildCadena(order);
  const key = forge.pki.privateKeyFromPem(privateKeyPem);
  const md = forge.md.sha256.create();
  md.update(cadena, 'utf8');
  const signature = key.sign(md);
  return forge.util.encode64(signature);
}

/**
 * Verify a STP signature using RSA-SHA256 and a PEM public key via node-forge.
 */
export function verifySignature(
  order: StpSpeiOrder,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const cadena = buildCadena(order);
    const key = forge.pki.publicKeyFromPem(publicKeyPem);
    const md = forge.md.sha256.create();
    md.update(cadena, 'utf8');
    const sigBytes = forge.util.decode64(signature);
    return key.verify(md.digest().bytes(), sigBytes);
  } catch {
    return false;
  }
}

// ── CLABE Validation ────────────────────────────────────────────────────────

/**
 * Validate that a string is a valid 18-digit CLABE (modulo 10 checksum).
 */
export function validateClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;

  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (parseInt(clabe[i], 10) * weights[i]) % 10;
  }
  const control = (10 - (sum % 10)) % 10;
  return control === parseInt(clabe[17], 10);
}

// ── Disbursement ────────────────────────────────────────────────────────────

/**
 * Build and send a SPEI order to STP, store the result in Firestore.
 */
export async function disburseSPEI(params: DisburseSPEIParams): Promise<DisburseSPEIResult> {
  if (!validateClabe(params.clabe)) {
    throw new Error(`Invalid CLABE: ${params.clabe}`);
  }

  const empresa = process.env.STP_EMPRESA ?? 'VIDA SOFOM';
  const folioOrigen = `VIDA-${params.loanId}-${Date.now()}`;

  const order: StpSpeiOrder & Record<string, unknown> = {
    empresa,
    folioOrigen,
    causaDevolucion: '',
    cuenta: params.clabe,
    rfcCurpBeneficiario: 'ND',
    nombreBeneficiario: params.beneficiaryName,
    conceptoPago: 'Prestamo VIDA Finance',
    monto: params.amount,
    tipoPago: 1,
    topologia: 'T',
    medioEntrega: 3,
    prioridad: 1,
    iva: 0,
  };

  const privateKey = process.env.STP_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('STP_PRIVATE_KEY is required for signing');
  }

  const firma = signOrder(order, privateKey);

  const stpApiUrl = process.env.STP_API_URL ?? 'https://demo.stpmex.com:7002';
  const response = await axios.post<{ id: string | number }>(
    `${stpApiUrl}/spei/ordenaPago`,
    { ...order, firma },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.STP_API_KEY ? { Authorization: `Bearer ${process.env.STP_API_KEY}` } : {}),
      },
      timeout: 30_000,
    },
  );

  await db.collection('disbursements').doc(params.loanId).set({
    stpFolioOrigen: folioOrigen,
    stpId: String(response.data.id),
    status: 'pending_confirmation',
    amount: params.amount,
    clabe: params.clabe,
    userId: params.userId,
    beneficiaryName: params.beneficiaryName,
    sentAt: admin.firestore.Timestamp.now(),
  });

  await db.collection('loans').doc(params.loanId).update({
    status: 'disbursement_sent',
    stpFolioOrigen: folioOrigen,
  });

  return { stpId: response.data.id, folioOrigen };
}
