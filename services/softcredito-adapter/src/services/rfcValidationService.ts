import axios from 'axios';
import redis from '../lib/redis';
import { RfcValidationRequest, RfcValidationResult, SatRfcApiResponse } from '../types/rfc';
import { fuzzyNameMatch } from './renapoCurpService';

const RFC_CACHE_TTL = 24 * 3600; // 24 hours

export async function validateRfc(req: RfcValidationRequest): Promise<RfcValidationResult> {
  const normalized = req.rfc.toUpperCase().trim();
  const cacheKey = `bureau:rfc:${normalized}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    const result = JSON.parse(cached) as RfcValidationResult;
    if (req.expectedName && result.legalName) {
      result.matchesExpectedName = fuzzyNameMatch(req.expectedName, result.legalName);
    }
    return { ...result, source: 'cache' };
  }

  const response = await axios.get<SatRfcApiResponse>(
    `${process.env.RENAPO_API_URL}/rfc/${normalized}`,
    { headers: { Accept: 'application/json' }, timeout: 10_000 },
  );

  const data = response.data;

  let type: 'persona_fisica' | 'persona_moral' | undefined;
  if (data.tipoPersona === 'fisica' || normalized.length === 13) {
    type = 'persona_fisica';
  } else if (data.tipoPersona === 'moral' || normalized.length === 12) {
    type = 'persona_moral';
  }

  const result: RfcValidationResult = {
    valid: data.valid,
    rfc: normalized,
    legalName: data.razonSocial,
    type,
    taxStatus: data.situacionFiscal,
    source: 'sat_api',
    validatedAt: new Date().toISOString(),
  };

  if (req.expectedName && result.legalName) {
    result.matchesExpectedName = fuzzyNameMatch(req.expectedName, result.legalName);
  }

  await redis.setex(cacheKey, RFC_CACHE_TTL, JSON.stringify(result));
  return result;
}
