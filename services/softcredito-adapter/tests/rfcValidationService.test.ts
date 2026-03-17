process.env.REDIS_URL = 'redis://localhost:6379';
process.env.RENAPO_API_URL = 'https://sesna.gob.mx/api/v1';

import axios from 'axios';
import redis from '../src/lib/redis';
import { __resetStore } from './__mocks__/redis';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { validateRfc } from '../src/services/rfcValidationService';

beforeEach(() => {
  jest.clearAllMocks();
  __resetStore();
});

describe('validateRfc', () => {
  const satResponse = {
    valid: true,
    rfc: 'GARA850101XX0',
    razonSocial: 'ARTURO GARCIA ROMERO',
    tipoPersona: 'fisica',
    situacionFiscal: 'Activo',
  };

  it('returns validated RFC data from SAT API', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    const result = await validateRfc({ rfc: 'GARA850101XX0' });

    expect(result.valid).toBe(true);
    expect(result.rfc).toBe('GARA850101XX0');
    expect(result.legalName).toBe('ARTURO GARCIA ROMERO');
    expect(result.type).toBe('persona_fisica');
    expect(result.taxStatus).toBe('Activo');
    expect(result.source).toBe('sat_api');
  });

  it('normalizes RFC to uppercase', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    const result = await validateRfc({ rfc: 'gara850101xx0' });

    expect(result.rfc).toBe('GARA850101XX0');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://sesna.gob.mx/api/v1/rfc/GARA850101XX0',
      expect.any(Object),
    );
  });

  it('checks name match when expectedName is provided', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    const result = await validateRfc({
      rfc: 'GARA850101XX0',
      expectedName: 'Arturo García Romero',
    });

    expect(result.matchesExpectedName).toBe(true);
  });

  it('detects persona moral by RFC length (12 chars)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { ...satResponse, rfc: 'VID200101AB1', tipoPersona: undefined },
    });

    const result = await validateRfc({ rfc: 'VID200101AB1' });

    expect(result.type).toBe('persona_moral');
  });

  it('returns cached result on second call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    const first = await validateRfc({ rfc: 'GARA850101XX0' });
    expect(first.source).toBe('sat_api');

    const second = await validateRfc({ rfc: 'GARA850101XX0' });
    expect(second.source).toBe('cache');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('caches with 24-hour TTL', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    await validateRfc({ rfc: 'GARA850101XX0' });

    expect(redis.setex).toHaveBeenCalledWith(
      'bureau:rfc:GARA850101XX0',
      24 * 3600,
      expect.any(String),
    );
  });

  it('re-evaluates name match on cached result with new expectedName', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: satResponse });

    await validateRfc({ rfc: 'GARA850101XX0' });

    const cached = await validateRfc({
      rfc: 'GARA850101XX0',
      expectedName: 'Maria Lopez',
    });

    expect(cached.source).toBe('cache');
    expect(cached.matchesExpectedName).toBe(false);
  });

  it('propagates API errors', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('SAT service unavailable'));

    await expect(validateRfc({ rfc: 'GARA850101XX0' })).rejects.toThrow(
      'SAT service unavailable',
    );
  });
});
