import axios from 'axios';
import https from 'https';
import redis from '../lib/redis';
import { BureauQueryRequest, BureauQueryResult, SoftcreditoApiResponse } from '../types/bureau';

/**
 * Derives scDiasAtraso: maximum days past due across all accounts.
 * Uses the top-level `diasAtraso` if present, otherwise scans individual `cuentas`.
 */
function extractMaxDiasAtraso(data: SoftcreditoApiResponse): number | undefined {
  if (typeof data.diasAtraso === 'number') return data.diasAtraso;
  if (!data.cuentas?.length) return undefined;
  const values = data.cuentas
    .map((c) => c.diasAtraso)
    .filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : undefined;
}

/**
 * Derives scCarteraVencida: true when any account has saldoVencido > 0,
 * or when the top-level flag is explicitly set.
 */
function extractCarteraVencida(data: SoftcreditoApiResponse): boolean | undefined {
  if (typeof data.carteraVencida === 'boolean') return data.carteraVencida;
  if (!data.cuentas?.length) return undefined;
  return data.cuentas.some((c) => typeof c.saldoVencido === 'number' && c.saldoVencido > 0);
}

function mapSoftcreditoResponse(data: SoftcreditoApiResponse): Omit<BureauQueryResult, 'source'> {
  let paymentHistory: 'good' | 'irregular' | 'bad' | undefined;
  if (data.historialPagos) {
    if (data.historialPagos === 'bueno') paymentHistory = 'good';
    else if (data.historialPagos === 'irregular') paymentHistory = 'irregular';
    else paymentHistory = 'bad';
  }

  return {
    found: data.encontrado ?? false,
    cdcScore: data.scoreCDC,
    bdcScore: data.scoreBDC,
    riskScore: data.score,
    openAccounts: data.cuentasAbiertas,
    totalDebt: data.deudaTotal,
    paymentHistory,
    scDiasAtraso: extractMaxDiasAtraso(data),
    scCarteraVencida: extractCarteraVencida(data),
    fraudFlags: data.alertasFraude,
    queriedAt: new Date().toISOString(),
  };
}

export async function queryBureau(req: BureauQueryRequest): Promise<BureauQueryResult> {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `bureau:query:${req.curp}:${today}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return { ...(JSON.parse(cached) as BureauQueryResult), source: 'cache' };
  }

  // mTLS: certificate stored as base64-encoded PEM in env
  const cert = Buffer.from(process.env.SOFTCREDITO_CERTIFICATE!, 'base64');
  const httpsAgent = new https.Agent({
    cert,
    key: cert,
    rejectUnauthorized: process.env.NODE_ENV === 'production',
  });

  const response = await axios.post<SoftcreditoApiResponse>(
    `${process.env.SOFTCREDITO_API_URL}/consulta`,
    {
      usuario: process.env.SOFTCREDITO_USER,
      contrasena: process.env.SOFTCREDITO_PASSWORD,
      curp: req.curp,
      nombre: req.fullName,
      fechaNacimiento: req.dateOfBirth,
      rfc: req.rfc ?? '',
    },
    { httpsAgent, timeout: 15_000 },
  );

  const result = mapSoftcreditoResponse(response.data);
  const ttl = parseInt(process.env.REDIS_CACHE_TTL ?? '86400', 10);
  await redis.setex(cacheKey, ttl, JSON.stringify(result));

  return { ...result, source: 'softcredito_api' };
}
