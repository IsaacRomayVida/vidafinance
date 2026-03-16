import axios from 'axios';
import https from 'https';
import redis from '../lib/redis';
import { BureauQueryRequest, BureauQueryResult, SoftcreditoApiResponse } from '../types/bureau';

function mapSoftcreditoResponse(data: SoftcreditoApiResponse): Omit<BureauQueryResult, 'source'> {
  let paymentHistory: 'good' | 'irregular' | 'bad' | undefined;
  if (data.historialPagos) {
    if (data.historialPagos === 'bueno') paymentHistory = 'good';
    else if (data.historialPagos === 'irregular') paymentHistory = 'irregular';
    else paymentHistory = 'bad';
  }

  return {
    found: data.encontrado ?? false,
    riskScore: data.score,
    openAccounts: data.cuentasAbiertas,
    totalDebt: data.deudaTotal,
    paymentHistory,
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
