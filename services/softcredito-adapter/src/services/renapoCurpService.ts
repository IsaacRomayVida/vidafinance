import axios from 'axios';
import redis from '../lib/redis';
import { CurpValidationRequest, CurpValidationResult, RenapoApiResponse } from '../types/curp';

const CURP_CACHE_TTL = 7 * 24 * 3600; // 7 days — CURP data is stable

/**
 * Normalizes a Spanish name string for fuzzy comparison:
 * lowercases, strips diacritics, collapses whitespace.
 */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true if every word in `expected` appears in `actual` (after normalization).
 * This handles reordered names and missing middle names gracefully.
 */
export function fuzzyNameMatch(expected: string, actual: string): boolean {
  const e = normalizeName(expected);
  const a = normalizeName(actual);
  if (e === a) return true;
  const eWords = e.split(' ');
  const aWords = a.split(' ');
  return eWords.every((w) => aWords.includes(w));
}

export async function validateCurp(req: CurpValidationRequest): Promise<CurpValidationResult> {
  const cacheKey = `bureau:renapo:${req.curp.toUpperCase()}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    const result = JSON.parse(cached) as CurpValidationResult;
    return { ...result, source: 'cache' };
  }

  const response = await axios.get<RenapoApiResponse>(
    `${process.env.RENAPO_API_URL}/curp/${req.curp.toUpperCase()}`,
    { headers: { Accept: 'application/json' }, timeout: 10_000 },
  );

  const data = response.data;
  const fullName = `${data.nombre} ${data.primerApellido} ${data.segundoApellido}`.trim();

  const result: CurpValidationResult = {
    valid: data.statusOper === '01',
    curp: req.curp.toUpperCase(),
    fullName,
    dateOfBirth: data.fechaNacimiento,
    stateOfBirth: data.claveEntidadRegistro,
    // RENAPO uses 'H' (Hombre) and 'M' (Mujer) — map to 'M'/'F' for API consumers
    gender: data.sexo === 'H' ? 'M' : 'F',
    nationality: data.nacionalidad,
    source: 'renapo_api',
    validatedAt: new Date().toISOString(),
  };

  if (req.expectedName) {
    result.matchesExpectedName = fuzzyNameMatch(req.expectedName, fullName);
  }

  await redis.setex(cacheKey, CURP_CACHE_TTL, JSON.stringify(result));
  return result;
}
