import crypto from 'crypto';

/**
 * STP SPEI order fields that are included in the RSA-SHA256 signature.
 * The concatenation order follows STP's specification for ordenaPago.
 */
export interface StpOrder {
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
  // Optional fields
  claveRastreo?: string;
  tipoCuentaOrdenante?: number;
  nombreOrdenante?: string;
  cuentaOrdenante?: string;
  rfcCurpOrdenante?: string;
  referenciaNumerica?: number;
  tipoCuentaBeneficiario?: number;
}

/**
 * Build the pipe-delimited cadena string that STP requires to be signed.
 * Fields are concatenated as: |{leading_empty}|field1|...|fieldN|{trailing_empty}|
 * Order must match STP's ordenaPago specification exactly.
 */
export function buildStpCadena(order: StpOrder): string {
  const fields = [
    '',                                      // leading empty for double pipe
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
    '',                                      // trailing empty for double pipe
  ];
  return `|${fields.join('|')}`;
}

/**
 * Sign a STP order using RSA-SHA256 with the provided PEM private key.
 * Returns the base64-encoded signature suitable for the `firma` field.
 */
export function signStpOrder(order: StpOrder, privateKeyPem: string): string {
  const cadena = buildStpCadena(order);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(cadena);
  return sign.sign(privateKeyPem, 'base64');
}

/**
 * Verify a STP signature using RSA-SHA256 and a PEM public key.
 * Used in tests and for incoming webhook validation.
 */
export function verifyStpSignature(
  order: StpOrder,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const cadena = buildStpCadena(order);
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(cadena);
    return verify.verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * Validate that a string is a valid 18-digit CLABE.
 * Uses the standard CLABE verification algorithm (modulo 10).
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
