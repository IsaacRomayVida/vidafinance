process.env.REDIS_URL = 'redis://localhost:6379';
process.env.RENAPO_API_URL = 'https://sesna.gob.mx/api/v1';

import axios from 'axios';
import redis from '../src/lib/redis';
import { __resetStore } from './__mocks__/redis';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { validateCurp, fuzzyNameMatch } from '../src/services/renapoCurpService';

beforeEach(() => {
  jest.clearAllMocks();
  __resetStore();
});

describe('fuzzyNameMatch', () => {
  it('matches exact names', () => {
    expect(fuzzyNameMatch('Juan Perez', 'Juan Perez')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(fuzzyNameMatch('JUAN PEREZ', 'juan perez')).toBe(true);
  });

  it('matches with diacritics stripped', () => {
    expect(fuzzyNameMatch('José García', 'jose garcia')).toBe(true);
  });

  it('matches reordered names', () => {
    expect(fuzzyNameMatch('Juan Perez', 'Perez Juan')).toBe(true);
  });

  it('matches when expected has fewer words (missing middle name)', () => {
    expect(fuzzyNameMatch('Juan Perez', 'Juan Carlos Perez Lopez')).toBe(true);
  });

  it('returns false when names do not match', () => {
    expect(fuzzyNameMatch('Juan Perez', 'Maria Garcia')).toBe(false);
  });
});

describe('validateCurp', () => {
  const renapoResponse = {
    statusOper: '01',
    nombre: 'ARTURO',
    primerApellido: 'GARCIA',
    segundoApellido: 'ROMERO',
    fechaNacimiento: '01/01/1985',
    claveEntidadRegistro: 'DF',
    sexo: 'H' as const,
    nacionalidad: 'MEX',
  };

  it('returns validated CURP data from RENAPO', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: renapoResponse });

    const result = await validateCurp({ curp: 'GARA850101HDFRRL09' });

    expect(result.valid).toBe(true);
    expect(result.curp).toBe('GARA850101HDFRRL09');
    expect(result.fullName).toBe('ARTURO GARCIA ROMERO');
    expect(result.gender).toBe('M'); // H -> M
    expect(result.source).toBe('renapo_api');
  });

  it('checks name match when expectedName is provided', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: renapoResponse });

    const result = await validateCurp({
      curp: 'GARA850101HDFRRL09',
      expectedName: 'Arturo García Romero',
    });

    expect(result.matchesExpectedName).toBe(true);
  });

  it('returns false for name mismatch', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: renapoResponse });

    const result = await validateCurp({
      curp: 'GARA850101HDFRRL09',
      expectedName: 'Maria Lopez',
    });

    expect(result.matchesExpectedName).toBe(false);
  });

  it('returns cached result on second call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: renapoResponse });

    const first = await validateCurp({ curp: 'GARA850101HDFRRL09' });
    expect(first.source).toBe('renapo_api');

    const second = await validateCurp({ curp: 'GARA850101HDFRRL09' });
    expect(second.source).toBe('cache');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('caches with 7-day TTL', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: renapoResponse });

    await validateCurp({ curp: 'GARA850101HDFRRL09' });

    expect(redis.setex).toHaveBeenCalledWith(
      'bureau:renapo:GARA850101HDFRRL09',
      7 * 24 * 3600,
      expect.any(String),
    );
  });

  it('maps female gender correctly', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { ...renapoResponse, sexo: 'M' },
    });

    const result = await validateCurp({ curp: 'GARA850101MDFRRL09' });

    expect(result.gender).toBe('F');
  });

  it('propagates RENAPO API errors', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('RENAPO unavailable'));

    await expect(validateCurp({ curp: 'GARA850101HDFRRL09' })).rejects.toThrow(
      'RENAPO unavailable',
    );
  });
});
