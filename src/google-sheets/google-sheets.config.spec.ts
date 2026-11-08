import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSheetsClient } from './google-sheets.client';
import {
  DEFAULT_SHEET_NAME,
  DEFAULT_SHEETS_TIMEOUT_MS,
  DEFAULT_SHEETS_TIMEZONE,
  GOOGLE_SHEETS_SCOPES,
  GoogleSheetsConfigError,
  loadGoogleSheetsConfig,
  normalizePrivateKey,
} from './google-sheets.config';

describe('loadGoogleSheetsConfig (Story 03 – Service Account auth)', () => {
  const EMAIL = 'namsa-sync@namsa-ard.iam.gserviceaccount.com';
  const PEM =
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
  /** The key as it appears on a single .env line. */
  const PEM_ESCAPED = PEM.replace(/\n/g, '\\n');
  const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

  const keyJson = {
    type: 'service_account',
    project_id: 'namsa-ard',
    client_email: EMAIL,
    private_key: PEM,
  };

  it('is disabled (not an error) when nothing is configured', () => {
    const config = loadGoogleSheetsConfig({});
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toMatch(/not set/);
    expect(config.sheetName).toBe(DEFAULT_SHEET_NAME);
  });

  it('treats empty strings from .env.example as not configured', () => {
    const config = loadGoogleSheetsConfig({
      GOOGLE_SHEETS_SPREADSHEET_ID: '',
      GOOGLE_SERVICE_ACCOUNT_JSON: '""',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: '  ',
    });
    expect(config.enabled).toBe(false);
  });

  describe('credential sources', () => {
    it('reads raw JSON from GOOGLE_SERVICE_ACCOUNT_JSON', () => {
      const config = loadGoogleSheetsConfig({
        GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson),
      });
      expect(config).toMatchObject({
        enabled: true,
        spreadsheetId: SHEET_ID,
        sheetName: DEFAULT_SHEET_NAME,
        timeZone: DEFAULT_SHEETS_TIMEZONE,
        requestTimeoutMs: DEFAULT_SHEETS_TIMEOUT_MS,
        credentials: {
          client_email: EMAIL,
          private_key: PEM,
          project_id: 'namsa-ard',
        },
      });
      expect(config.keyFile).toBeUndefined();
    });

    it('reads base64-encoded JSON from GOOGLE_SERVICE_ACCOUNT_JSON', () => {
      const config = loadGoogleSheetsConfig({
        GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(
          JSON.stringify(keyJson),
        ).toString('base64'),
      });
      expect(config.credentials?.client_email).toBe(EMAIL);
      expect(config.credentials?.private_key).toBe(PEM);
    });

    it('reads email + escaped private key', () => {
      const config = loadGoogleSheetsConfig({
        GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL,
        GOOGLE_PRIVATE_KEY: `"${PEM_ESCAPED}"`,
      });
      expect(config.credentials).toEqual({
        client_email: EMAIL,
        private_key: PEM,
      });
    });

    it('reads and validates a key file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsheets-'));
      const file = path.join(dir, 'key.json');
      fs.writeFileSync(file, JSON.stringify(keyJson, null, 2));
      try {
        const config = loadGoogleSheetsConfig({
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file,
        });
        expect(config.keyFile).toBe(file);
        expect(config.credentials).toEqual({
          client_email: EMAIL,
          private_key: PEM,
          project_id: 'namsa-ard',
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to GOOGLE_APPLICATION_CREDENTIALS for the key file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsheets-'));
      const file = path.join(dir, 'key.json');
      fs.writeFileSync(file, JSON.stringify(keyJson));
      try {
        const config = loadGoogleSheetsConfig({
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_APPLICATION_CREDENTIALS: file,
        });
        expect(config.keyFile).toBe(file);
        expect(config.credentials?.client_email).toBe(EMAIL);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a key file that is not a service account key', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsheets-'));
      const file = path.join(dir, 'key.json');
      fs.writeFileSync(file, '{}');
      try {
        expect(() =>
          loadGoogleSheetsConfig({
            GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
            GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file,
          }),
        ).toThrow(/key file .* must provide both client_email and private_key/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('prefers GOOGLE_SERVICE_ACCOUNT_JSON over the other sources', () => {
      const config = loadGoogleSheetsConfig({
        GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson),
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'other@x.iam.gserviceaccount.com',
        GOOGLE_PRIVATE_KEY: PEM_ESCAPED,
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/does/not/exist.json',
      });
      expect(config.credentials?.client_email).toBe(EMAIL);
    });
  });

  it('applies custom sheet name, time zone and timeout', () => {
    const config = loadGoogleSheetsConfig({
      GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson),
      GOOGLE_SHEETS_SHEET_NAME: "Kiosk Logs '26",
      GOOGLE_SHEETS_TIMEZONE: 'UTC',
      GOOGLE_SHEETS_TIMEOUT_MS: '5000',
    });
    expect(config.sheetName).toBe("Kiosk Logs '26");
    expect(config.timeZone).toBe('UTC');
    expect(config.requestTimeoutMs).toBe(5000);
  });

  describe('misconfiguration fails fast', () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      [
        'credentials without spreadsheet ID',
        { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson) },
        /GOOGLE_SHEETS_SPREADSHEET_ID is missing/,
      ],
      [
        'spreadsheet ID without credentials',
        { GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID },
        /no service account credentials/,
      ],
      [
        'malformed JSON',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_JSON: '{not json',
        },
        /neither valid JSON/,
      ],
      [
        'non-service-account JSON',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
            ...keyJson,
            type: 'authorized_user',
          }),
        },
        /expected "service_account"/,
      ],
      [
        'email without private key',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL,
        },
        /both client_email and private_key/,
      ],
      [
        'private key that is not PEM',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL,
          GOOGLE_PRIVATE_KEY: 'not-a-key',
        },
        /not a PEM private key/,
      ],
      [
        'invalid email',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_EMAIL: 'nope',
          GOOGLE_PRIVATE_KEY: PEM_ESCAPED,
        },
        /not a valid service account email/,
      ],
      [
        'missing key file',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/definitely/missing/key.json',
        },
        /does not exist/,
      ],
      [
        'invalid time zone',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson),
          GOOGLE_SHEETS_TIMEZONE: 'Mars/Olympus',
        },
        /not a valid IANA time zone/,
      ],
      [
        'invalid timeout',
        {
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyJson),
          GOOGLE_SHEETS_TIMEOUT_MS: '-1',
        },
        /positive integer/,
      ],
    ];

    it.each(cases)('%s', (_name, env, message) => {
      expect(() => loadGoogleSheetsConfig(env)).toThrow(
        GoogleSheetsConfigError,
      );
      expect(() => loadGoogleSheetsConfig(env)).toThrow(message);
    });

    it('never leaks the private key in error messages', () => {
      let message = '';
      try {
        loadGoogleSheetsConfig({
          GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
          GOOGLE_SERVICE_ACCOUNT_EMAIL: 'nope',
          GOOGLE_PRIVATE_KEY: PEM_ESCAPED,
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/not a valid service account email/);
      expect(message).not.toContain('MIIEvQ');
    });
  });

  describe('normalizePrivateKey', () => {
    it('turns \\n escapes into newlines and ends with a newline', () => {
      expect(normalizePrivateKey(PEM_ESCAPED)).toBe(PEM);
    });

    it('leaves a real multi-line key intact', () => {
      expect(normalizePrivateKey(PEM)).toBe(PEM);
    });
  });

  describe('createSheetsClient', () => {
    it('constructs a Google Sheets v4 client with JWT Service Account auth and retry disabled', () => {
      const config = loadGoogleSheetsConfig({
        GOOGLE_SHEETS_SPREADSHEET_ID: SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: EMAIL,
        GOOGLE_PRIVATE_KEY: PEM_ESCAPED,
        GOOGLE_SHEETS_TIMEOUT_MS: '8000',
      });

      const client = createSheetsClient(config) as unknown as {
        spreadsheets: { values: { append: unknown } };
        context: {
          _options: {
            timeout: number;
            retry: boolean;
            auth: { email: string; key: string; scopes: string[] };
          };
        };
      };

      expect(typeof client.spreadsheets.values.append).toBe('function');
      expect(client.context._options.timeout).toBe(8000);
      expect(client.context._options.retry).toBe(false);
      expect(client.context._options.auth.email).toBe(EMAIL);
      expect(client.context._options.auth.key).toBe(PEM);
      expect(client.context._options.auth.scopes).toEqual(GOOGLE_SHEETS_SCOPES);
    });

    it('throws GoogleSheetsConfigError when called without credentials', () => {
      const disabled = loadGoogleSheetsConfig({});
      expect(() => createSheetsClient(disabled)).toThrow(
        GoogleSheetsConfigError,
      );
    });
  });
});
