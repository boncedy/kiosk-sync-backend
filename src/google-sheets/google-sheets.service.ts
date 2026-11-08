import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { GoogleSheetsConfig } from './google-sheets.config';
import {
  columnLetter,
  DAILY_LOG_SHEET_HEADERS,
  mapDailyLogsToRows,
  SheetDailyLog,
  SheetRow,
} from './daily-log-row.mapper';
import {
  GoogleSheetsSyncError,
  toGoogleSheetsSyncError,
} from './google-sheets.errors';
import type {
  SheetsClient,
  SheetsSpreadsheetMetadata,
} from './sheets-client.types';

export const GOOGLE_SHEETS_CONFIG = Symbol('GOOGLE_SHEETS_CONFIG');
export const GOOGLE_SHEETS_CLIENT_FACTORY = Symbol(
  'GOOGLE_SHEETS_CLIENT_FACTORY',
);

export type SheetsClientFactory = (config: GoogleSheetsConfig) => SheetsClient;

/** Google Sheets limits a single append request to well under 10 MB; stay far below. */
export const MAX_ROWS_PER_APPEND = 500;

export interface AppendDailyLogsResult {
  /** Number of rows Google Sheets reports as written. */
  appendedRows: number;
  /** A1 range the rows landed in, e.g. "'DailyLogs'!A12:N14". */
  updatedRange: string | null;
  /** DailyLog IDs that were written, in order. Safe to mark as synced. */
  syncedLogIds: string[];
}

export interface SheetsConnectionInfo {
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
}

/**
 * Story 03 – Google Sheets API v4 integration (Service Account auth).
 *
 * Appends DailyLog records to the configured spreadsheet tab using the
 * column layout from `daily-log-row.mapper.ts`. This service only talks to
 * Google Sheets; scheduling, retry queueing and audit logging belong to the
 * sync pipeline that calls it. Every failure surfaces as a
 * `GoogleSheetsSyncError` whose `retryable` flag tells that pipeline whether to
 * re-queue the rows (429 / 5xx / network) or record a permanent failure.
 */
@Injectable()
export class GoogleSheetsService implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetsService.name);
  private client?: SheetsClient;
  private headerReady = false;

  constructor(
    @Inject(GOOGLE_SHEETS_CONFIG) private readonly config: GoogleSheetsConfig,
    @Inject(GOOGLE_SHEETS_CLIENT_FACTORY)
    private readonly clientFactory: SheetsClientFactory,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        `Google Sheets sync is disabled: ${this.config.disabledReason ?? 'not configured'}`,
      );
      return;
    }
    const identity =
      this.config.credentials?.client_email ??
      `key file ${this.config.keyFile ?? '(unknown)'}`;
    this.logger.log(
      `Google Sheets sync enabled → spreadsheet ${this.config.spreadsheetId}, ` +
        `tab "${this.config.sheetName}", service account ${identity}`,
    );
  }

  /** Whether Google Sheets credentials and a spreadsheet are configured. */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /** A1 notation of the configured tab, quoted for names with spaces/quotes. */
  get sheetRangePrefix(): string {
    return `'${this.config.sheetName.replace(/'/g, "''")}'`;
  }

  private get lastColumn(): string {
    return columnLetter(DAILY_LOG_SHEET_HEADERS.length);
  }

  private getClient(): SheetsClient {
    if (!this.config.enabled) {
      throw new GoogleSheetsSyncError(
        `Google Sheets sync is disabled: ${this.config.disabledReason ?? 'not configured'}`,
        { kind: 'DISABLED', retryable: false },
      );
    }
    if (!this.client) {
      this.client = this.clientFactory(this.config);
    }
    return this.client;
  }

  /**
   * Checks that the service account can open the spreadsheet and that the
   * target tab exists. Useful as a health check before the first sync.
   */
  async verifyConnection(): Promise<SheetsConnectionInfo> {
    const client = this.getClient();
    let metadata: SheetsSpreadsheetMetadata;
    try {
      const response = await client.spreadsheets.get({
        spreadsheetId: this.config.spreadsheetId,
        fields: 'properties.title,sheets.properties.title',
      });
      metadata = response.data;
    } catch (err) {
      throw toGoogleSheetsSyncError(
        err,
        [],
        'Could not open the Google Spreadsheet (is it shared with the service account?)',
      );
    }

    const tabs = (metadata.sheets ?? []).map((s) => s.properties?.title);
    if (!tabs.includes(this.config.sheetName)) {
      throw new GoogleSheetsSyncError(
        `Tab "${this.config.sheetName}" not found in spreadsheet ` +
          `(available: ${tabs.filter(Boolean).join(', ') || 'none'})`,
        { kind: 'NOT_FOUND', retryable: false },
      );
    }

    return {
      spreadsheetId: this.config.spreadsheetId,
      spreadsheetTitle: metadata.properties?.title ?? '',
      sheetName: this.config.sheetName,
    };
  }

  /**
   * Makes sure row 1 holds `DAILY_LOG_SHEET_HEADERS`. Writes the header row on
   * an empty sheet; refuses to continue if row 1 holds different headers, since
   * appending would then put values under the wrong columns. Extra trailing
   * header cells (manual columns added after ours) are allowed.
   */
  async ensureHeaderRow(): Promise<void> {
    if (this.headerReady) return;
    const client = this.getClient();
    const range = `${this.sheetRangePrefix}!A1:${this.lastColumn}1`;

    let existing: string[];
    try {
      const { data } = await client.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range,
      });
      existing = (data.values?.[0] ?? []).map((v) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v).trim()
          : '',
      );
    } catch (err) {
      throw toGoogleSheetsSyncError(
        err,
        [],
        'Could not read the sheet header row',
      );
    }

    if (existing.every((cell) => cell === '')) {
      try {
        await client.spreadsheets.values.update({
          spreadsheetId: this.config.spreadsheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: {
            majorDimension: 'ROWS',
            values: [[...DAILY_LOG_SHEET_HEADERS]],
          },
        });
      } catch (err) {
        throw toGoogleSheetsSyncError(
          err,
          [],
          'Could not write the sheet header row',
        );
      }
      this.logger.log(`Wrote header row to tab "${this.config.sheetName}"`);
      this.headerReady = true;
      return;
    }

    const mismatch = DAILY_LOG_SHEET_HEADERS.findIndex(
      (header, i) => existing[i] !== header,
    );
    if (mismatch !== -1) {
      throw new GoogleSheetsSyncError(
        `Header mismatch in tab "${this.config.sheetName}" at column ` +
          `${columnLetter(mismatch + 1)}: expected "${DAILY_LOG_SHEET_HEADERS[mismatch]}", ` +
          `found "${existing[mismatch] ?? ''}". Fix the header row before syncing.`,
        { kind: 'HEADER_MISMATCH', retryable: false },
      );
    }
    this.headerReady = true;
  }

  /** Formats DailyLogs into sheet rows using the configured time zone. */
  formatRows(logs: readonly SheetDailyLog[]): SheetRow[] {
    return mapDailyLogsToRows(logs, { timeZone: this.config.timeZone });
  }

  /**
   * Appends DailyLogs as new rows below the existing data (rows are inserted,
   * so they pick up the formatting of the table above).
   *
   * All logs in one call go out in a single request: either every row is
   * written or none is, and on failure the thrown `GoogleSheetsSyncError`
   * lists every log ID in `rowIds` for the retry queue.
   */
  async appendDailyLogs(
    logs: readonly SheetDailyLog[],
  ): Promise<AppendDailyLogsResult> {
    if (logs.length === 0) {
      return { appendedRows: 0, updatedRange: null, syncedLogIds: [] };
    }

    const rowIds = logs.map((log) => log.id);
    if (logs.length > MAX_ROWS_PER_APPEND) {
      throw new GoogleSheetsSyncError(
        `Cannot append ${logs.length} rows in one request (max ${MAX_ROWS_PER_APPEND}); split the batch`,
        { kind: 'BAD_REQUEST', retryable: false, rowIds },
      );
    }

    try {
      const client = this.getClient();
      await this.ensureHeaderRow();

      const { data } = await client.spreadsheets.values.append({
        spreadsheetId: this.config.spreadsheetId,
        range: `${this.sheetRangePrefix}!A:${this.lastColumn}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        includeValuesInResponse: false,
        requestBody: { majorDimension: 'ROWS', values: this.formatRows(logs) },
      });

      const appendedRows = data.updates?.updatedRows ?? logs.length;
      const updatedRange = data.updates?.updatedRange ?? null;
      this.logger.log(
        `Appended ${appendedRows} row(s) to Google Sheets${updatedRange ? ` at ${updatedRange}` : ''}`,
      );
      return { appendedRows, updatedRange, syncedLogIds: rowIds };
    } catch (err) {
      const error = toGoogleSheetsSyncError(
        err,
        rowIds,
        'Failed to append rows to Google Sheets',
      );
      // A header problem may be fixed by hand; re-check it on the next attempt.
      if (error.kind === 'HEADER_MISMATCH' || error.kind === 'NOT_FOUND') {
        this.headerReady = false;
      }
      this.logger.warn(
        `${error.message} [rows=${rowIds.length}, retryable=${error.retryable}]`,
      );
      throw error;
    }
  }
}
