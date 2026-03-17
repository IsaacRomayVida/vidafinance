process.env.REDIS_URL = 'redis://localhost:6379';
process.env.SOFTCREDITO_API_URL = 'https://ws.softcredito.com.mx/api';
process.env.SOFTCREDITO_USER = 'testuser';
process.env.SOFTCREDITO_PASSWORD = 'testpass';
process.env.SOFTCREDITO_CERTIFICATE = Buffer.from('test-cert').toString('base64');
process.env.RENAPO_API_URL = 'https://sesna.gob.mx/api/v1';
process.env.INTERNAL_SECRET = 'test-secret';
process.env.NODE_ENV = 'staging';

import axios from 'axios';
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock ioredis before importing the app
jest.mock('ioredis', () => {
  const store: Record<string, string> = {};
  return {
    default: jest.fn().mockImplementation(() => ({
      ping: jest.fn(async () => 'PONG'),
      get: jest.fn(async (key: string) => store[key] ?? null),
      setex: jest.fn(async (key: string, _ttl: number, value: string) => {
        store[key] = value;
        return 'OK';
      }),
      on: jest.fn(),
    })),
  };
});

// Mock firebase-admin before importing the app
jest.mock('firebase-admin', () => ({
  apps: [{}],
  app: jest.fn(() => ({})),
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({ exists: false, data: () => undefined })),
        set: jest.fn(),
        update: jest.fn(),
      })),
      add: jest.fn(),
    })),
  })),
}));

import request from 'supertest';
import app from '../src/index';

describe('POST /bureau/query', () => {
  it('returns 401 without internal secret', async () => {
    const res = await request(app)
      .post('/bureau/query')
      .send({ curp: 'GARA850101HDFRRL09', fullName: 'Test', dateOfBirth: '1985-01-01' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 400 when curp is missing', async () => {
    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', 'test-secret')
      .send({ fullName: 'Test', dateOfBirth: '1985-01-01' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('returns 400 for invalid dateOfBirth format', async () => {
    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', 'test-secret')
      .send({ curp: 'GARA850101HDFRRL09', fullName: 'Test', dateOfBirth: '01-01-1985' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('returns bureau result with CDC/BDC scores on success', async () => {
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

    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', 'test-secret')
      .send({
        curp: 'GARA850101HDFRRL09',
        fullName: 'ARTURO GARCIA ROMERO',
        dateOfBirth: '1985-01-01',
      });

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.cdcScore).toBe(680);
    expect(res.body.bdcScore).toBe(620);
    expect(res.body.scDiasAtraso).toBe(0);
    expect(res.body.scCarteraVencida).toBe(false);
  });

  it('uppercases CURP before querying', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { encontrado: false },
    });

    await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', 'test-secret')
      .send({
        curp: 'zzaa770303hdfrrl05',
        fullName: 'Test',
        dateOfBirth: '1977-03-03',
      });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ curp: 'ZZAA770303HDFRRL05' }),
      expect.any(Object),
    );
  });

  it('returns 502 on API error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app)
      .post('/bureau/query')
      .set('x-internal-secret', 'test-secret')
      .send({
        curp: 'XXYY990202MDFRRL01',
        fullName: 'Test Error',
        dateOfBirth: '1999-02-02',
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Connection refused/);
  });
});

describe('POST /curp/validate', () => {
  it('returns 401 without internal secret', async () => {
    const res = await request(app)
      .post('/curp/validate')
      .send({ curp: 'GARA850101HDFRRL09' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when curp is missing', async () => {
    const res = await request(app)
      .post('/curp/validate')
      .set('x-internal-secret', 'test-secret')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/curp is required/);
  });

  it('returns 400 for invalid CURP format', async () => {
    const res = await request(app)
      .post('/curp/validate')
      .set('x-internal-secret', 'test-secret')
      .send({ curp: 'INVALID' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid CURP format/);
  });

  it('validates CURP successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        statusOper: '01',
        nombre: 'ARTURO',
        primerApellido: 'GARCIA',
        segundoApellido: 'ROMERO',
        fechaNacimiento: '01/01/1985',
        claveEntidadRegistro: 'DF',
        sexo: 'H',
        nacionalidad: 'MEX',
      },
    });

    const res = await request(app)
      .post('/curp/validate')
      .set('x-internal-secret', 'test-secret')
      .send({ curp: 'GARA850101HDFRRL09' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.fullName).toBe('ARTURO GARCIA ROMERO');
  });
});

describe('POST /rfc/validate', () => {
  it('returns 401 without internal secret', async () => {
    const res = await request(app)
      .post('/rfc/validate')
      .send({ rfc: 'GARA850101XX0' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when rfc is missing', async () => {
    const res = await request(app)
      .post('/rfc/validate')
      .set('x-internal-secret', 'test-secret')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rfc is required/);
  });

  it('returns 400 for invalid RFC format', async () => {
    const res = await request(app)
      .post('/rfc/validate')
      .set('x-internal-secret', 'test-secret')
      .send({ rfc: 'BAD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid RFC format/);
  });

  it('validates RFC successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        valid: true,
        rfc: 'GARA850101XX0',
        razonSocial: 'ARTURO GARCIA ROMERO',
        tipoPersona: 'fisica',
        situacionFiscal: 'Activo',
      },
    });

    const res = await request(app)
      .post('/rfc/validate')
      .set('x-internal-secret', 'test-secret')
      .send({ rfc: 'GARA850101XX0' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.type).toBe('persona_fisica');
    expect(res.body.legalName).toBe('ARTURO GARCIA ROMERO');
  });

  it('returns 502 on SAT API error', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('SAT timeout'));

    const res = await request(app)
      .post('/rfc/validate')
      .set('x-internal-secret', 'test-secret')
      .send({ rfc: 'XXYY990202AB3' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/SAT timeout/);
  });
});

describe('GET /health', () => {
  it('returns health status', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('vida-softcredito-adapter');
    expect(res.body.status).toBe('ok');
    expect(res.body.redis).toBe('ok');
  });
});
