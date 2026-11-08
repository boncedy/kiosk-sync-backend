// ───────────────────────────────────────────────────────────
//  Story 03 – Google Sheets error classification
//
//  Every failure from the Sheets API is normalised into a
//  `GoogleSheetsSyncError` carrying the affected DailyLog IDs and a
//  `retryable` flag, so the scheduled sync job can decide between
//  "queue for retry with backoff" and "record in system_audit_logs and stop".
// ───────────────────────────────────────────────────────────

/** HTTP statuses worth retrying: rate limit, timeout and transient server errors. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Node / fetch error codes that indicate a transient network failure. */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'AbortError',
  'TimeoutError',
]);

export type GoogleSheetsErrorKind =
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'SERVER'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'DISABLED'
  | 'HEADER_MISMATCH'
  | 'UNKNOWN';

export interface GoogleSheetsSyncErrorOptions {
  kind: GoogleSheetsErrorKind;
  retryable: boolean;
  status?: number;
  code?: string;
  rowIds?: readonly string[];
  cause?: unknown;
}

export class GoogleSheetsSyncError extends Error {
  readonly kind: GoogleSheetsErrorKind;
  readonly retryable: boolean;
  /** HTTP status returned by the Sheets API, if any. */
  readonly status?: number;
  /** Network / system error code, if any (e.g. ETIMEDOUT). */
  readonly code?: string;
  /** DailyLog IDs that were NOT written because of this error. */
  readonly rowIds: readonly string[];

  constructor(message: string, options: GoogleSheetsSyncErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'GoogleSheetsSyncError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code;
    this.rowIds = options.rowIds ?? [];
  }
}

function readStatus(err: Record<string, unknown>): number | undefined {
  if (typeof err.status === 'number') return err.status;
  if (typeof err.code === 'number') return err.code;
  const response = err.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

function readCode(err: Record<string, unknown>): string | undefined {
  if (typeof err.code === 'string') return err.code;
  if (typeof err.name === 'string' && RETRYABLE_NETWORK_CODES.has(err.name)) {
    return err.name;
  }
  const cause = err.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}

function kindFor(
  status: number | undefined,
  networkError: boolean,
): GoogleSheetsErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (networkError || status === 408) return 'NETWORK';
  if (status !== undefined && status >= 500) return 'SERVER';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400) return 'BAD_REQUEST';
  return 'UNKNOWN';
}

/**
 * Normalises any error thrown by the Sheets client into a
 * `GoogleSheetsSyncError`. Already-normalised errors are returned with the
 * given `rowIds` attached.
 */
export function toGoogleSheetsSyncError(
  err: unknown,
  rowIds: readonly string[] = [],
  context = 'Google Sheets request failed',
): GoogleSheetsSyncError {
  if (err instanceof GoogleSheetsSyncError) {
    if (rowIds.length === 0 || err.rowIds.length > 0) return err;
    return new GoogleSheetsSyncError(err.message, {
      kind: err.kind,
      retryable: err.retryable,
      status: err.status,
      code: err.code,
      rowIds,
      cause: err.cause,
    });
  }

  const obj =
    typeof err === 'object' && err !== null
      ? (err as Record<string, unknown>)
      : {};
  const status = readStatus(obj);
  const code = readCode(obj);
  const networkError = code !== undefined && RETRYABLE_NETWORK_CODES.has(code);
  const retryable =
    networkError || (status !== undefined && RETRYABLE_STATUSES.has(status));

  const detail =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const tag = [status !== undefined ? `HTTP ${status}` : null, code ?? null]
    .filter(Boolean)
    .join(' ');

  return new GoogleSheetsSyncError(
    `${context}${tag ? ` (${tag})` : ''}: ${detail}`,
    {
      kind: kindFor(status, networkError),
      retryable,
      status,
      code,
      rowIds,
      cause: err,
    },
  );
}
