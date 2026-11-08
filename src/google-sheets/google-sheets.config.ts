import * as fs from 'fs';

// ───────────────────────────────────────────────────────────
//  Story 03 – Google Sheets Service Account configuration
//
//  Credentials are read from the environment only (never committed). The
//  first source found wins:
//    1. GOOGLE_SERVICE_ACCOUNT_JSON   – the whole key file as JSON or base64
//    2. GOOGLE_SERVICE_ACCOUNT_EMAIL  – the key's `client_email` …
//       GOOGLE_PRIVATE_KEY            – … and `private_key` (`\n` escapes ok)
//    3. GOOGLE_SERVICE_ACCOUNT_KEY_FILE (or GOOGLE_APPLICATION_CREDENTIALS)
//                                     – path to the downloaded JSON key file
//
//  Leaving every Google Sheets variable empty disables the integration (the
//  server still boots). Setting only some of them is a misconfiguration and
//  fails fast with a `GoogleSheetsConfigError`.
// ───────────────────────────────────────────────────────────

/** Read/write access to spreadsheets shared with the service account. */
export const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
];

export const DEFAULT_SHEET_NAME = 'DailyLogs';
export const DEFAULT_SHEETS_TIMEZONE = 'Asia/Bangkok';
export const DEFAULT_SHEETS_TIMEOUT_MS = 15_000;

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface GoogleSheetsConfig {
  /** `false` when no Google Sheets variable is set at all. */
  enabled: boolean;
  /** Why the integration is disabled (only set when `enabled` is false). */
  disabledReason?: string;
  spreadsheetId: string;
  /** Tab (worksheet) the rows are appended to. */
  sheetName: string;
  /** IANA time zone used to render timestamps in the sheet. */
  timeZone: string;
  /** Per-request timeout for Sheets API calls. */
  requestTimeoutMs: number;
  /** Service account credentials, from whichever source was configured. */
  credentials?: ServiceAccountCredentials;
  /** Path of the key file the credentials were read from (source 3 only). */
  keyFile?: string;
}

export class GoogleSheetsConfigError extends Error {
  constructor(message: string) {
    super(`Google Sheets configuration error: ${message}`);
    this.name = 'GoogleSheetsConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Trims a value and drops one pair of wrapping quotes left by some env loaders. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v === '' ? undefined : v;
}

/** Turns literal `\n` sequences (how keys are stored on one env line) into newlines. */
export function normalizePrivateKey(key: string): string {
  return key.replace(/\\r/g, '').replace(/\\n/g, '\n').trim() + '\n';
}

function validateCredentials(
  raw: Partial<ServiceAccountCredentials>,
  source: string,
): ServiceAccountCredentials {
  const clientEmail = clean(raw.client_email);
  const privateKey = clean(raw.private_key);

  if (!clientEmail || !privateKey) {
    throw new GoogleSheetsConfigError(
      `${source} must provide both client_email and private_key`,
    );
  }
  if (!clientEmail.includes('@')) {
    throw new GoogleSheetsConfigError(
      `${source} client_email "${clientEmail}" is not a valid service account email`,
    );
  }

  const key = normalizePrivateKey(privateKey);
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new GoogleSheetsConfigError(
      `${source} private_key is not a PEM private key (expected "-----BEGIN PRIVATE KEY-----")`,
    );
  }

  return {
    client_email: clientEmail,
    private_key: key,
    ...(raw.project_id ? { project_id: raw.project_id } : {}),
  };
}

/** Parses a service account key given as raw JSON or base64-encoded JSON. */
function parseServiceAccountJson(
  value: string,
  source = 'GOOGLE_SERVICE_ACCOUNT_JSON',
): ServiceAccountCredentials {
  const text = value.startsWith('{')
    ? value
    : Buffer.from(value, 'base64').toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GoogleSheetsConfigError(
      `${source} is neither valid JSON nor base64-encoded JSON`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GoogleSheetsConfigError(`${source} must be a JSON object`);
  }

  const json = parsed as Record<string, unknown>;
  if (json.type !== undefined && json.type !== 'service_account') {
    throw new GoogleSheetsConfigError(
      `${source} has type ${JSON.stringify(json.type)}, expected "service_account"`,
    );
  }

  return validateCredentials(
    {
      client_email:
        typeof json.client_email === 'string' ? json.client_email : undefined,
      private_key:
        typeof json.private_key === 'string' ? json.private_key : undefined,
      project_id:
        typeof json.project_id === 'string' ? json.project_id : undefined,
    },
    source,
  );
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new GoogleSheetsConfigError(
      `GOOGLE_SHEETS_TIMEZONE "${timeZone}" is not a valid IANA time zone`,
    );
  }
}

/**
 * Builds the Google Sheets configuration from environment variables
 * (reading the key file from disk when that source is used).
 */
export function loadGoogleSheetsConfig(
  env: Env = process.env,
): GoogleSheetsConfig {
  const spreadsheetId = clean(env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const sheetName = clean(env.GOOGLE_SHEETS_SHEET_NAME) ?? DEFAULT_SHEET_NAME;
  const timeZone = clean(env.GOOGLE_SHEETS_TIMEZONE) ?? DEFAULT_SHEETS_TIMEZONE;

  const timeoutRaw = clean(env.GOOGLE_SHEETS_TIMEOUT_MS);
  const requestTimeoutMs =
    timeoutRaw === undefined ? DEFAULT_SHEETS_TIMEOUT_MS : Number(timeoutRaw);

  const json = clean(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const email = clean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = clean(env.GOOGLE_PRIVATE_KEY);
  const keyFile =
    clean(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) ??
    clean(env.GOOGLE_APPLICATION_CREDENTIALS);

  const hasCredentials = Boolean(json || email || privateKey || keyFile);

  const base = { sheetName, timeZone, requestTimeoutMs };

  if (!spreadsheetId && !hasCredentials) {
    return {
      ...base,
      enabled: false,
      disabledReason:
        'GOOGLE_SHEETS_SPREADSHEET_ID and service account credentials are not set',
      spreadsheetId: '',
    };
  }

  if (!spreadsheetId) {
    throw new GoogleSheetsConfigError(
      'service account credentials are set but GOOGLE_SHEETS_SPREADSHEET_ID is missing',
    );
  }
  if (!hasCredentials) {
    throw new GoogleSheetsConfigError(
      'GOOGLE_SHEETS_SPREADSHEET_ID is set but no service account credentials were found ' +
        '(set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY, ' +
        'or GOOGLE_SERVICE_ACCOUNT_KEY_FILE)',
    );
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new GoogleSheetsConfigError(
      `GOOGLE_SHEETS_TIMEOUT_MS must be a positive integer (got "${timeoutRaw}")`,
    );
  }
  assertValidTimeZone(timeZone);

  const config: GoogleSheetsConfig = { ...base, enabled: true, spreadsheetId };

  if (json) {
    config.credentials = parseServiceAccountJson(json);
  } else if (email || privateKey) {
    config.credentials = validateCredentials(
      { client_email: email, private_key: privateKey },
      'GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY',
    );
  } else if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      throw new GoogleSheetsConfigError(
        `service account key file "${keyFile}" does not exist`,
      );
    }
    config.credentials = parseServiceAccountJson(
      fs.readFileSync(keyFile, 'utf8').trim(),
      `key file "${keyFile}"`,
    );
    config.keyFile = keyFile;
  }

  return config;
}
