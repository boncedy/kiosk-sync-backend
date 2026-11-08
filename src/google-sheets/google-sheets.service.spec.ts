import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { GoogleSheetsConfig } from './google-sheets.config';
import { DAILY_LOG_SHEET_HEADERS, SheetDailyLog } from './daily-log-row.mapper';
import {
  GoogleSheetsSyncError,
  toGoogleSheetsSyncError,
} from './google-sheets.errors';
import {
  GOOGLE_SHEETS_CLIENT_FACTORY,
  GOOGLE_SHEETS_CONFIG,
  GoogleSheetsService,
  MAX_ROWS_PER_APPEND,
} from './google-sheets.service';
import type { SheetsClient } from './sheets-client.types';

const enabledConfig: GoogleSheetsConfig = {
  enabled: true,
  spreadsheetId: 'sheet-123',
  sheetName: 'DailyLogs',
  timeZone: 'Asia/Bangkok',
  requestTimeoutMs: 15000,
  credentials: {
    client_email: 'sync@namsa-ard.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
  },
};

function makeLog(id: string): SheetDailyLog {
  return {
    id,
    transactionId: `TXN-${id}`,
    kioskId: 'KIOSK-001',
    operatorId: 'OP-104',
    meterVolume: 500,
    reportedCash: 950,
    expectedRevenue: 1000,
    variance: -50,
    isAnomaly: false,
    recordedAt: '2026-10-31T10:00:00.000Z',
    createdAt: '2026-10-31T10:00:01.000Z',
    checksum: 'abc123',
  };
}

function httpError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status, code: status });
}

function networkError(code: string) {
  return Object.assign(new Error(`connect ${code}`), { code });
}

function makeFakeClient(
  headerRow: unknown[] | null = [...DAILY_LOG_SHEET_HEADERS],
) {
  const fake = {
    spreadsheets: {
      get: jest.fn().mockResolvedValue({
        data: {
          properties: { title: 'Namsa-ard Sync' },
          sheets: [{ properties: { title: 'DailyLogs' } }],
        },
      }),
      values: {
        get: jest.fn().mockResolvedValue({
          data: { values: headerRow ? [headerRow] : undefined },
        }),
        update: jest.fn().mockResolvedValue({ data: {} }),
        append: jest
          .fn()
          .mockImplementation(
            (params: { requestBody: { values: unknown[][] } }) =>
              Promise.resolve({
                data: {
                  updates: {
                    updatedRange: `'DailyLogs'!A2:O${1 + params.requestBody.values.length}`,
                    updatedRows: params.requestBody.values.length,
                  },
                },
              }),
          ),
      },
    },
  };
  return fake;
}

async function createService(
  config: GoogleSheetsConfig,
  client: ReturnType<typeof makeFakeClient>,
) {
  const factory = jest.fn().mockReturnValue(client as unknown as SheetsClient);
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: GOOGLE_SHEETS_CONFIG, useValue: config },
      { provide: GOOGLE_SHEETS_CLIENT_FACTORY, useValue: factory },
      GoogleSheetsService,
    ],
  }).compile();
  return { service: moduleRef.get(GoogleSheetsService), factory };
}

describe('GoogleSheetsService (Story 03)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  describe('appendDailyLogs', () => {
    it('appends mapped rows with USER_ENTERED + INSERT_ROWS to the configured tab', async () => {
      const client = makeFakeClient();
      const { service, factory } = await createService(enabledConfig, client);

      const result = await service.appendDailyLogs([
        makeLog('a'),
        makeLog('b'),
      ]);

      expect(factory).toHaveBeenCalledWith(enabledConfig);
      expect(client.spreadsheets.values.append).toHaveBeenCalledTimes(1);
      const params = client.spreadsheets.values.append.mock.calls[0][0];
      expect(params).toMatchObject({
        spreadsheetId: 'sheet-123',
        range: "'DailyLogs'!A:O",
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { majorDimension: 'ROWS' },
      });
      expect(params.requestBody.values).toEqual(
        service.formatRows([makeLog('a'), makeLog('b')]),
      );
      expect(params.requestBody.values[0][11]).toBe('2026-10-31 17:00:00');

      expect(result).toEqual({
        appendedRows: 2,
        updatedRange: "'DailyLogs'!A2:O3",
        syncedLogIds: ['a', 'b'],
      });
    });

    it('is a no-op for an empty batch', async () => {
      const client = makeFakeClient();
      const { service, factory } = await createService(enabledConfig, client);

      await expect(service.appendDailyLogs([])).resolves.toEqual({
        appendedRows: 0,
        updatedRange: null,
        syncedLogIds: [],
      });
      expect(factory).not.toHaveBeenCalled();
    });

    it('creates the client once and verifies the header only once', async () => {
      const client = makeFakeClient();
      const { service, factory } = await createService(enabledConfig, client);

      await service.appendDailyLogs([makeLog('a')]);
      await service.appendDailyLogs([makeLog('b')]);

      expect(factory).toHaveBeenCalledTimes(1);
      expect(client.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(client.spreadsheets.values.append).toHaveBeenCalledTimes(2);
    });

    it('quotes sheet names containing spaces and apostrophes', async () => {
      const client = makeFakeClient();
      const { service } = await createService(
        { ...enabledConfig, sheetName: "Kiosk Logs '26" },
        client,
      );

      await service.appendDailyLogs([makeLog('a')]);

      expect(client.spreadsheets.values.append.mock.calls[0][0].range).toBe(
        "'Kiosk Logs ''26'!A:O",
      );
    });

    it('rejects batches larger than MAX_ROWS_PER_APPEND without calling the API', async () => {
      const client = makeFakeClient();
      const { service } = await createService(enabledConfig, client);
      const logs = Array.from({ length: MAX_ROWS_PER_APPEND + 1 }, (_, i) =>
        makeLog(String(i)),
      );

      await expect(service.appendDailyLogs(logs)).rejects.toMatchObject({
        kind: 'BAD_REQUEST',
        retryable: false,
      });
      expect(client.spreadsheets.values.append).not.toHaveBeenCalled();
    });

    it('throws a non-retryable DISABLED error when not configured', async () => {
      const client = makeFakeClient();
      const { service, factory } = await createService(
        { ...enabledConfig, enabled: false, disabledReason: 'not set' },
        client,
      );

      expect(service.isEnabled).toBe(false);
      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).rejects.toMatchObject({
        name: 'GoogleSheetsSyncError',
        kind: 'DISABLED',
        retryable: false,
        rowIds: ['a'],
      });
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('failure classification for the retry queue', () => {
    it.each([
      ['429 rate limit', httpError(429), 'RATE_LIMITED', true],
      ['503 unavailable', httpError(503), 'SERVER', true],
      ['500 internal', httpError(500), 'SERVER', true],
      ['network reset', networkError('ECONNRESET'), 'NETWORK', true],
      ['network timeout', networkError('ETIMEDOUT'), 'NETWORK', true],
      ['DNS failure', networkError('EAI_AGAIN'), 'NETWORK', true],
      ['403 not shared with service account', httpError(403), 'AUTH', false],
      ['404 spreadsheet missing', httpError(404), 'NOT_FOUND', false],
      ['400 bad range', httpError(400), 'BAD_REQUEST', false],
    ])(
      '%s → kind=%s retryable=%s with all row IDs attached',
      async (_n, error, kind, retryable) => {
        const client = makeFakeClient();
        client.spreadsheets.values.append.mockRejectedValueOnce(error);
        const { service } = await createService(enabledConfig, client);

        const promise = service.appendDailyLogs([makeLog('a'), makeLog('b')]);

        await expect(promise).rejects.toBeInstanceOf(GoogleSheetsSyncError);
        await expect(promise).rejects.toMatchObject({
          kind,
          retryable,
          rowIds: ['a', 'b'],
        });
      },
    );

    it('recovers on the next call after a transient failure', async () => {
      const client = makeFakeClient();
      client.spreadsheets.values.append.mockRejectedValueOnce(httpError(429));
      const { service } = await createService(enabledConfig, client);

      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).rejects.toMatchObject({
        retryable: true,
      });
      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).resolves.toMatchObject({
        appendedRows: 1,
        syncedLogIds: ['a'],
      });
    });

    it('attaches row IDs when the header read fails', async () => {
      const client = makeFakeClient();
      client.spreadsheets.values.get.mockRejectedValueOnce(
        networkError('ECONNRESET'),
      );
      const { service } = await createService(enabledConfig, client);

      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).rejects.toMatchObject({
        kind: 'NETWORK',
        retryable: true,
        rowIds: ['a'],
      });
      expect(client.spreadsheets.values.append).not.toHaveBeenCalled();
    });
  });

  describe('ensureHeaderRow', () => {
    it('writes the header row on an empty sheet using RAW input', async () => {
      const client = makeFakeClient(null);
      const { service } = await createService(enabledConfig, client);

      await service.ensureHeaderRow();

      expect(client.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'DailyLogs'!A1:O1",
      });
      expect(client.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'DailyLogs'!A1:O1",
        valueInputOption: 'RAW',
        requestBody: {
          majorDimension: 'ROWS',
          values: [[...DAILY_LOG_SHEET_HEADERS]],
        },
      });
    });

    it('leaves a matching header row untouched (extra trailing columns allowed)', async () => {
      const client = makeFakeClient([
        ...DAILY_LOG_SHEET_HEADERS,
        'Manager Notes',
      ]);
      const { service } = await createService(enabledConfig, client);

      await service.ensureHeaderRow();

      expect(client.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it('refuses to append when the header row does not match', async () => {
      const wrong = [...DAILY_LOG_SHEET_HEADERS];
      wrong[3] = 'Water Type';
      const client = makeFakeClient(wrong);
      const { service } = await createService(enabledConfig, client);

      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).rejects.toMatchObject({
        kind: 'HEADER_MISMATCH',
        retryable: false,
        rowIds: ['a'],
        message: expect.stringContaining('column D'),
      });
      expect(client.spreadsheets.values.append).not.toHaveBeenCalled();

      // After the header is fixed by hand, the next attempt re-checks and succeeds.
      client.spreadsheets.values.get.mockResolvedValue({
        data: { values: [[...DAILY_LOG_SHEET_HEADERS]] },
      });
      await expect(
        service.appendDailyLogs([makeLog('a')]),
      ).resolves.toMatchObject({
        appendedRows: 1,
      });
    });
  });

  describe('verifyConnection', () => {
    it('returns spreadsheet title and tab when reachable', async () => {
      const client = makeFakeClient();
      const { service } = await createService(enabledConfig, client);

      await expect(service.verifyConnection()).resolves.toEqual({
        spreadsheetId: 'sheet-123',
        spreadsheetTitle: 'Namsa-ard Sync',
        sheetName: 'DailyLogs',
      });
    });

    it('reports a missing tab', async () => {
      const client = makeFakeClient();
      const { service } = await createService(
        { ...enabledConfig, sheetName: 'Nope' },
        client,
      );

      await expect(service.verifyConnection()).rejects.toMatchObject({
        kind: 'NOT_FOUND',
        message: expect.stringContaining('available: DailyLogs'),
      });
    });

    it('reports a spreadsheet not shared with the service account', async () => {
      const client = makeFakeClient();
      client.spreadsheets.get.mockRejectedValueOnce(
        httpError(403, 'permission denied'),
      );
      const { service } = await createService(enabledConfig, client);

      await expect(service.verifyConnection()).rejects.toMatchObject({
        kind: 'AUTH',
        retryable: false,
        message: expect.stringContaining('shared with the service account'),
      });
    });
  });
});

describe('toGoogleSheetsSyncError', () => {
  it('reads the status from a gaxios-style response object', () => {
    const err = toGoogleSheetsSyncError({ response: { status: 429 } }, ['x']);
    expect(err).toMatchObject({
      kind: 'RATE_LIMITED',
      retryable: true,
      status: 429,
    });
  });

  it('treats AbortError / TimeoutError as retryable network failures', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(toGoogleSheetsSyncError(abort)).toMatchObject({
      kind: 'NETWORK',
      retryable: true,
      code: 'TimeoutError',
    });
  });

  it('reads a network code from error.cause', () => {
    const err = new Error('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    expect(toGoogleSheetsSyncError(err)).toMatchObject({
      kind: 'NETWORK',
      retryable: true,
    });
  });

  it('marks unknown errors as non-retryable and keeps the original as cause', () => {
    const original = new Error('boom');
    const err = toGoogleSheetsSyncError(original, ['a']);
    expect(err).toMatchObject({
      kind: 'UNKNOWN',
      retryable: false,
      rowIds: ['a'],
    });
    expect(err.cause).toBe(original);
  });

  it('adds row IDs to an existing GoogleSheetsSyncError without changing it', () => {
    const base = new GoogleSheetsSyncError('nope', {
      kind: 'DISABLED',
      retryable: false,
    });
    const err = toGoogleSheetsSyncError(base, ['a']);
    expect(err).toMatchObject({
      kind: 'DISABLED',
      message: 'nope',
      rowIds: ['a'],
    });
  });
});
