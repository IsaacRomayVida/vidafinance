process.env.REDIS_URL = 'redis://localhost:6379';
process.env.SOFTCREDITO_API_URL = 'https://ws.softcredito.com.mx/api';
process.env.SOFTCREDITO_USER = 'testuser';
process.env.SOFTCREDITO_PASSWORD = 'testpass';
process.env.SOFTCREDITO_CERTIFICATE = Buffer.from('test-cert-pem').toString('base64');
process.env.REDIS_CACHE_TTL = '86400';
process.env.NODE_ENV = 'staging';

import axios from 'axios';
import redis from '../src/lib/redis';
import { __resetStore } from './__mocks__/redis';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

import { queryBureau } from '../src/services/softcreditoService';

const baseRequest = {
  curp: 'GARA850101HDFRRL09',
  fullName: 'ARTURO GARCIA ROMERO',
  dateOfBirth: '1985-01-01',
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetStore();
});

describe('queryBureau', () => {
  it('returns CDC and BDC scores from API response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        encontrado: true,
        score: 650,
        scoreCDC: 680,
        scoreBDC: 620,
        cuentasAbiertas: 3,
        deudaTotal: 15000,
        historialPagos: 'bueno',
        alertasFraude: [],
        diasAtraso: 0,
        carteraVencida: false,
      },
    });

    const result = await queryBureau(baseRequest);

    expect(result.found).toBe(true);
    expect(result.cdcScore).toBe(680);
    expect(result.bdcScore).toBe(620);
    expect(result.riskScore).toBe(650);
    expect(result.scDiasAtraso).toBe(0);
    expect(result.scCarteraVencida).toBe(false);
    expect(result.paymentHistory).toBe('good');
    expect(result.source).toBe('softcredito_api');
  });

  it('extracts max diasAtraso from cuentas when top-level diasAtraso is absent', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        encontrado: true,
        score: 500,
        cuentas: [
          { diasAtraso: 30, saldoVencido: 0 },
          { diasAtraso: 90, saldoVencido: 5000 },
          { diasAtraso: 15, saldoVencido: 0 },
        ],
      },
    });

    const result = await queryBureau(baseRequest);

    expect(result.scDiasAtraso).toBe(90);
    expect(result.scCarteraVencida).toBe(true);
  });

  it('derives scCarteraVencida from cuentas with saldoVencido > 0', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        encontrado: true,
        cuentas: [
          { diasAtraso: 0, saldoVencido: 0 },
          { diasAtraso: 0, saldoVencido: 0 },
        ],
      },
    });

    const result = await queryBureau(baseRequest);

    expect(result.scCarteraVencida).toBe(false);
  });

  it('returns undefined for scDiasAtraso and scCarteraVencida when no data available', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: true, score: 700 },
    });

    const result = await queryBureau(baseRequest);

    expect(result.scDiasAtraso).toBeUndefined();
    expect(result.scCarteraVencida).toBeUndefined();
  });

  it('maps payment history correctly for irregular and bad', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: true, historialPagos: 'irregular' },
    });
    const r1 = await queryBureau(baseRequest);
    expect(r1.paymentHistory).toBe('irregular');

    __resetStore();
    jest.clearAllMocks();

    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: true, historialPagos: 'malo' },
    });
    const r2 = await queryBureau({ ...baseRequest, curp: 'GARA850101HDFRRL10' });
    expect(r2.paymentHistory).toBe('bad');
  });

  it('returns cached result on subsequent calls same day', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        encontrado: true,
        score: 650,
        scoreCDC: 680,
        scoreBDC: 620,
        diasAtraso: 0,
        carteraVencida: false,
      },
    });

    const first = await queryBureau(baseRequest);
    expect(first.source).toBe('softcredito_api');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    const second = await queryBureau(baseRequest);
    expect(second.source).toBe('cache');
    expect(second.cdcScore).toBe(680);
    expect(second.bdcScore).toBe(620);
    expect(second.scDiasAtraso).toBe(0);
    expect(second.scCarteraVencida).toBe(false);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1); // no additional call
  });

  it('caches result with configured TTL', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: true, score: 600 },
    });

    await queryBureau(baseRequest);

    expect(redis.setex).toHaveBeenCalledWith(
      expect.stringContaining('bureau:query:GARA850101HDFRRL09:'),
      86400,
      expect.any(String),
    );
  });

  it('sends correct request body to SoftCrédito API', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: false },
    });

    await queryBureau({ ...baseRequest, rfc: 'GARA850101XX0' });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://ws.softcredito.com.mx/api/consulta',
      {
        usuario: 'testuser',
        contrasena: 'testpass',
        curp: 'GARA850101HDFRRL09',
        nombre: 'ARTURO GARCIA ROMERO',
        fechaNacimiento: '1985-01-01',
        rfc: 'GARA850101XX0',
      },
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('propagates API errors', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(queryBureau(baseRequest)).rejects.toThrow('Network timeout');
  });

  it('handles not-found response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: false },
    });

    const result = await queryBureau(baseRequest);

    expect(result.found).toBe(false);
    expect(result.cdcScore).toBeUndefined();
    expect(result.bdcScore).toBeUndefined();
  });

  it('uses top-level carteraVencida flag when present', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        encontrado: true,
        carteraVencida: true,
        cuentas: [{ diasAtraso: 0, saldoVencido: 0 }],
      },
    });

    const result = await queryBureau(baseRequest);

    // top-level flag takes precedence over cuentas derivation
    expect(result.scCarteraVencida).toBe(true);
  });
});
