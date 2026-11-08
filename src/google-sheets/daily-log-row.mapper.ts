// ───────────────────────────────────────────────────────────
//  Story 03 – DailyLog → Google Sheets row mapper
//
//  Turns a `DailyLog` record into an ordered row array whose cells line up
//  with `DAILY_LOG_SHEET_HEADERS`. Rows are written with
//  `valueInputOption: USER_ENTERED`, so the cell types below are chosen to
//  keep the sheet's column formatting intact:
//    • numbers stay JS numbers → number/currency formats apply
//    • timestamps become "yyyy-MM-dd HH:mm:ss" in the configured time zone
//      → Sheets stores a real date-time value and applies the column format
//    • booleans stay booleans → TRUE/FALSE (checkbox / conditional formats)
//    • missing values become "" → an empty cell, never "null"/"undefined"
//    • text that Sheets would re-interpret (formulas, numbers, dates) is
//      prefixed with an apostrophe so it is stored verbatim as text — this
//      also blocks formula injection through kiosk-supplied strings.
//
//  Matches the Sprint 2 Prisma `DailyLog` model (including `WaterType`,
//  reconciliation metrics in KES, `proofImageUrl`, and `isReadByManager`).
// ───────────────────────────────────────────────────────────

/** The subset of a DailyLog the sheet needs. A Prisma `DailyLog` satisfies it. */
export interface SheetDailyLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: Date | string;
  createdAt: Date | string;
  operatorId?: string | null;
  waterType?: string | null;
  reportedCash?: number | null;
  expectedRevenue?: number | null;
  variance?: number | null;
  isAnomaly?: boolean | null;
  proofImageUrl?: string | null;
  checksum?: string | null;
  isSynced?: boolean | null;
  isReadByManager?: boolean | null;
}

export type SheetCellValue = string | number | boolean;
export type SheetRow = SheetCellValue[];

export interface SheetRowOptions {
  /** IANA time zone for timestamp columns. Defaults to Asia/Bangkok. */
  timeZone?: string;
}

interface SheetColumn {
  header: string;
  cell: (log: SheetDailyLog, timeZone: string) => SheetCellValue;
}

const EMPTY = '';

/** Characters that make Sheets treat a USER_ENTERED string as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
/** Strings Sheets would silently convert to a number, percent or currency. */
const NUMBER_LIKE =
  /^\s*[-+]?(?:[$฿€£]|KSh|KES)?\s*(\d[\d,]*\.?\d*|\.\d+)([eE][-+]?\d+)?\s*%?\s*$/i;
/** Strings Sheets would silently convert to a date or time. */
const DATE_LIKE = /^\s*(\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?|\d{1,2}:\d{2})/;
const BOOLEAN_LIKE = /^\s*(true|false)\s*$/i;

/**
 * Formats free text so Sheets stores it exactly as given. Values that would be
 * evaluated as a formula or coerced into a number/date/boolean get a leading
 * apostrophe (hidden by Sheets, keeps the cell a plain string).
 */
export function toSheetText(value: string | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  const text = String(value);
  if (text === EMPTY) return EMPTY;
  if (
    FORMULA_PREFIX.test(text) ||
    NUMBER_LIKE.test(text) ||
    DATE_LIKE.test(text) ||
    BOOLEAN_LIKE.test(text)
  ) {
    return `'${text}`;
  }
  return text;
}

/** Rounds to `digits` decimals, avoiding float artefacts like 0.30000000000000004. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toSheetNumber(
  value: number | null | undefined,
  digits: number,
): number | string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY;
  }
  return roundTo(value, digits);
}

function toSheetBoolean(value: boolean | null | undefined): boolean | string {
  return typeof value === 'boolean' ? value : EMPTY;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Renders a timestamp as "yyyy-MM-dd HH:mm:ss" in `timeZone` — an unambiguous
 * layout that USER_ENTERED parses into a real date-time in every locale.
 * Invalid or missing dates become an empty cell.
 */
export function formatSheetDateTime(
  value: Date | string | null | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined || value === EMPTY) return EMPTY;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EMPTY;

  const parts: Record<string, string> = {};
  for (const part of getDateTimeFormatter(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * Discrepancy ratio in percent: variance ÷ expected revenue × 100.
 * Empty when either value is missing or expected revenue is zero.
 */
export function discrepancyPercent(log: SheetDailyLog): number | string {
  const { variance, expectedRevenue } = log;
  if (
    variance === null ||
    variance === undefined ||
    expectedRevenue === null ||
    expectedRevenue === undefined ||
    !Number.isFinite(variance) ||
    !Number.isFinite(expectedRevenue) ||
    expectedRevenue === 0
  ) {
    return EMPTY;
  }
  return roundTo((variance / expectedRevenue) * 100, 2);
}

/**
 * Column order of the synced sheet. Append new columns at the END only —
 * reordering would shift data under existing headers in the live sheet.
 */
export const DAILY_LOG_SHEET_COLUMNS: readonly SheetColumn[] = [
  { header: 'Log ID', cell: (l) => toSheetText(l.id) },
  { header: 'Transaction ID', cell: (l) => toSheetText(l.transactionId) },
  { header: 'Kiosk ID', cell: (l) => toSheetText(l.kioskId) },
  { header: 'Operator ID', cell: (l) => toSheetText(l.operatorId) },
  { header: 'Water Type', cell: (l) => toSheetText(l.waterType) },
  { header: 'Meter Volume (L)', cell: (l) => toSheetNumber(l.meterVolume, 3) },
  {
    header: 'Reported Cash (KES)',
    cell: (l) => toSheetNumber(l.reportedCash, 2),
  },
  {
    header: 'Expected Revenue (KES)',
    cell: (l) => toSheetNumber(l.expectedRevenue, 2),
  },
  { header: 'Variance (KES)', cell: (l) => toSheetNumber(l.variance, 2) },
  { header: 'Discrepancy (%)', cell: (l) => discrepancyPercent(l) },
  { header: 'Anomaly', cell: (l) => toSheetBoolean(l.isAnomaly) },
  {
    header: 'Recorded At',
    cell: (l, tz) => formatSheetDateTime(l.recordedAt, tz),
  },
  {
    header: 'Server Received At',
    cell: (l, tz) => formatSheetDateTime(l.createdAt, tz),
  },
  { header: 'Checksum (SHA-256)', cell: (l) => toSheetText(l.checksum) },
  { header: 'Proof Image URL', cell: (l) => toSheetText(l.proofImageUrl) },
];

/** Header row written to row 1 of the sheet. */
export const DAILY_LOG_SHEET_HEADERS: readonly string[] =
  DAILY_LOG_SHEET_COLUMNS.map((c) => c.header);

/** Maps one DailyLog to a row whose cells follow `DAILY_LOG_SHEET_HEADERS`. */
export function mapDailyLogToRow(
  log: SheetDailyLog,
  options: SheetRowOptions = {},
): SheetRow {
  const timeZone = options.timeZone ?? 'Asia/Bangkok';
  return DAILY_LOG_SHEET_COLUMNS.map((column) => column.cell(log, timeZone));
}

/** Maps DailyLogs to rows, keeping the input order. */
export function mapDailyLogsToRows(
  logs: readonly SheetDailyLog[],
  options: SheetRowOptions = {},
): SheetRow[] {
  return logs.map((log) => mapDailyLogToRow(log, options));
}

/** Converts a 1-based column number to its A1 letter (1 → A, 27 → AA). */
export function columnLetter(columnNumber: number): string {
  if (!Number.isInteger(columnNumber) || columnNumber < 1) {
    throw new RangeError(`Invalid column number: ${columnNumber}`);
  }
  let n = columnNumber;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}
