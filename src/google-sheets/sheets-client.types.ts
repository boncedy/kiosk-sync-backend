import type { SheetRow } from './daily-log-row.mapper';

// ───────────────────────────────────────────────────────────
//  Minimal view of the googleapis Sheets v4 client used by
//  `GoogleSheetsService`. Keeping it narrow lets unit tests pass a plain fake
//  instead of the real client (and avoids loading `googleapis` in tests).
//  The real `sheets_v4.Sheets` instance is structurally compatible.
// ───────────────────────────────────────────────────────────

export interface SheetsApiResponse<T> {
  data: T;
}

export interface SheetsValueRange {
  range?: string | null;
  values?: unknown[][] | null;
}

export interface SheetsAppendResponse {
  tableRange?: string | null;
  updates?: {
    updatedRange?: string | null;
    updatedRows?: number | null;
    updatedCells?: number | null;
  } | null;
}

export interface SheetsSpreadsheetMetadata {
  properties?: { title?: string | null } | null;
  sheets?: Array<{
    properties?: { title?: string | null; sheetId?: number | null } | null;
  }> | null;
}

export interface SheetsClient {
  spreadsheets: {
    get(params: {
      spreadsheetId: string;
      fields?: string;
    }): Promise<SheetsApiResponse<SheetsSpreadsheetMetadata>>;
    values: {
      get(params: {
        spreadsheetId: string;
        range: string;
      }): Promise<SheetsApiResponse<SheetsValueRange>>;
      update(params: {
        spreadsheetId: string;
        range: string;
        valueInputOption: 'RAW' | 'USER_ENTERED';
        requestBody: { majorDimension: 'ROWS'; values: SheetRow[] };
      }): Promise<SheetsApiResponse<unknown>>;
      append(params: {
        spreadsheetId: string;
        range: string;
        valueInputOption: 'RAW' | 'USER_ENTERED';
        insertDataOption: 'INSERT_ROWS' | 'OVERWRITE';
        includeValuesInResponse?: boolean;
        requestBody: { majorDimension: 'ROWS'; values: SheetRow[] };
      }): Promise<SheetsApiResponse<SheetsAppendResponse>>;
    };
  };
}
