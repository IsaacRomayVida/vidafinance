/**
 * Tests for satBlacklistRefresh — parsing, normalization, GCS write,
 * Firestore meta, and the >5% parse-failure abort rule.
 *
 * Mocks are local to this file (via jest.mock) to avoid leaking storage
 * write semantics into the shared __mocks__/firebase-admin/storage.ts.
 */

const mockSave = jest.fn(async () => {});
const mockBucketFile = jest.fn((_path: string) => ({ save: mockSave }));
const mockBucket = jest.fn(() => ({ file: mockBucketFile }));
const mockGetStorage = jest.fn(() => ({ bucket: mockBucket }));

const mockMetaSet = jest.fn(async () => {});
const mockMetaDoc = jest.fn(() => ({ set: mockMetaSet }));
const mockCollection = jest.fn(() => ({ doc: mockMetaDoc }));
const mockGetFirestore = jest.fn(() => ({ collection: mockCollection }));

const mockSendSlack: jest.Mock = jest.fn(async (_msg?: string, _severity?: string) => {});

jest.mock('firebase-admin/storage', () => ({
  getStorage: () => mockGetStorage(),
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockGetFirestore(),
  FieldValue: { serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })) },
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromMillis: jest.fn(),
    fromDate: jest.fn(),
  },
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((_opts: unknown, handler: unknown) => handler),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onCall: jest.fn((_opts: unknown, handler: unknown) => handler),
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, msg: string) {
      super(msg);
    }
  },
}));

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../utils/slackAlert', () => ({
  sendSlackAlert: (msg: string, severity: string) => mockSendSlack(msg, severity),
}));

import fetch from 'node-fetch';
import {
  parseCsv,
  normalizeEfos,
  normalizeArt69,
  decodeLatin1,
  performRefresh,
} from '../satBlacklistRefresh';

const mockFetch = fetch as unknown as jest.Mock;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeResp = (text: string, ok = true, status = 200): any => ({
  ok,
  status,
  arrayBuffer: async () => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
  },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseCsv', () => {
  it('parses a simple header+rows csv', () => {
    const rows = parseCsv(
      'rfc,nombre\nXXXX010101AAA,Ana\nYYYY020202BBB,Bea\n'
    );
    expect(rows).toEqual([
      { rfc: 'XXXX010101AAA', nombre: 'Ana' },
      { rfc: 'YYYY020202BBB', nombre: 'Bea' },
    ]);
  });

  it('strips UTF-8 BOM and snake_cases header names', () => {
    const rows = parseCsv(
      '\uFEFFRFC,Nombre del Contribuyente\nABCD010101AAA,"Perez, J."\n'
    );
    expect(rows[0]).toEqual({
      rfc: 'ABCD010101AAA',
      nombre_del_contribuyente: 'Perez, J.',
    });
  });

  it('handles CRLF line endings and trailing commas', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n3,\r\n');
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '' },
    ]);
  });

  it('handles escaped quotes inside fields', () => {
    const rows = parseCsv('a\n"He said ""hi"""\n');
    expect(rows[0]).toEqual({ a: 'He said "hi"' });
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('decodeLatin1', () => {
  it('decodes Windows-1252 accented chars correctly', () => {
    // NIÑO más — 'Ñ'=0xD1, 'á'=0xE1 in Windows-1252
    const buf = Buffer.from([
      0x4e, 0x49, 0xd1, 0x4f, 0x20, 0x6d, 0xe1, 0x73,
    ]);
    expect(decodeLatin1(buf)).toBe('NIÑO más');
  });
});

describe('normalizeEfos', () => {
  it('keeps valid RFCs and uppercases the situacion', () => {
    const rows: Array<Record<string, string>> = [
      {
        rfc: 'ABCD010101AAA',
        nombre_del_contribuyente: 'Alpha',
        situacion: 'definitivo',
      },
      { rfc: 'BAD', situacion: 'definitivo' },
      {
        rfc: 'zzzz020202zzz',
        nombre_del_contribuyente: 'Zeta',
        situacion: 'presunto',
      },
    ];
    const result = normalizeEfos(rows);
    expect(result['ABCD010101AAA'].situacion).toBe('DEFINITIVO');
    expect(result['ZZZZ020202ZZZ'].situacion).toBe('PRESUNTO');
    expect(result['BAD']).toBeUndefined();
  });

  it('finds the situacion column even when named verbosely', () => {
    const result = normalizeEfos([
      {
        rfc: 'ABCD010101AAA',
        nombre: 'X',
        situacion_del_contribuyente: 'definitivo',
      },
    ]);
    expect(result['ABCD010101AAA'].situacion).toBe('DEFINITIVO');
  });
});

describe('normalizeArt69', () => {
  it('captures tipo_adeudo and monto from variant column names', () => {
    const result = normalizeArt69([
      {
        rfc: 'ABCD010101AAA',
        nombre: 'X',
        tipo_de_adeudo: 'Firme',
        monto: '100',
      },
    ]);
    expect(result['ABCD010101AAA']).toEqual({
      rfc: 'ABCD010101AAA',
      nombre: 'X',
      tipo_adeudo: 'Firme',
      monto: '100',
    });
  });

  it('drops rows with malformed RFCs', () => {
    const result = normalizeArt69([
      { rfc: 'BAD', nombre: 'X' },
      { rfc: 'ABCD010101AAA', nombre: 'X' },
    ]);
    expect(Object.keys(result)).toEqual(['ABCD010101AAA']);
  });
});

describe('performRefresh', () => {
  it('downloads both CSVs, writes GCS, and writes meta doc on success', async () => {
    const efosCsv =
      'rfc,nombre,situacion\nAAAA010101AAA,Alice,DEFINITIVO\nBBBB020202BBB,Bob,PRESUNTO\n';
    const art69Csv =
      'rfc,nombre,tipo_adeudo,monto\nAAAA010101AAA,Alice,Firme,100\n';

    mockFetch.mockImplementation((url: string) =>
      url.includes('69-B') ? makeResp(efosCsv) : makeResp(art69Csv)
    );

    const stats = await performRefresh();

    expect(stats.efosCount).toBe(2);
    expect(stats.art69Count).toBe(1);
    expect(stats.efosParseFailureRate).toBe(0);
    expect(stats.art69ParseFailureRate).toBe(0);

    expect(mockBucketFile).toHaveBeenCalledWith('sat/efos.json');
    expect(mockBucketFile).toHaveBeenCalledWith('sat/art69.json');
    expect(mockSave).toHaveBeenCalledTimes(2);
    const firstCall = mockSave.mock.calls[0] as unknown as [Buffer, unknown];
    const savedEfosBuf = firstCall[0];
    const savedPayload = JSON.parse(savedEfosBuf.toString());
    expect(savedPayload.rows['AAAA010101AAA'].situacion).toBe('DEFINITIVO');

    expect(mockCollection).toHaveBeenCalledWith('sat_refresh_meta');
    expect(mockMetaDoc).toHaveBeenCalledWith('latest');
    expect(mockMetaSet).toHaveBeenCalledWith(
      expect.objectContaining({
        efosCount: 2,
        art69Count: 1,
        status: 'ok',
      })
    );
  });

  it('throws and skips GCS writes when >5% of rows fail RFC validation', async () => {
    const badRows: string[] = ['rfc,situacion'];
    for (let i = 0; i < 100; i++) badRows.push(`INVALID${i},DEFINITIVO`);
    badRows.push('AAAA010101AAA,DEFINITIVO');
    const badCsv = badRows.join('\n');
    const okArt69 = 'rfc,nombre,tipo_adeudo,monto\nAAAA010101AAA,X,Firme,1\n';

    mockFetch
      .mockImplementationOnce(async () => makeResp(badCsv))
      .mockImplementationOnce(async () => makeResp(okArt69));

    await expect(performRefresh()).rejects.toThrow(
      /EFOS parse failure rate too high/
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockMetaSet).not.toHaveBeenCalled();
  });

  it('propagates HTTP errors from the source', async () => {
    mockFetch
      .mockImplementationOnce(async () => makeResp('', false, 503))
      .mockImplementationOnce(async () => makeResp('rfc\n'));

    await expect(performRefresh()).rejects.toThrow(/EFOS HTTP 503/);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('respects url overrides from opts', async () => {
    mockFetch.mockImplementation(() =>
      makeResp('rfc,nombre,situacion\nAAAA010101AAA,X,DEFINITIVO\n')
    );

    await performRefresh({
      efosUrl: 'https://example.test/efos.csv',
      art69Url: 'https://example.test/art69.csv',
    });

    const calledUrls = mockFetch.mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain('https://example.test/efos.csv');
    expect(calledUrls).toContain('https://example.test/art69.csv');
  });
});
