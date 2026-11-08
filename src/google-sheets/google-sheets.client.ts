import { google } from 'googleapis';
import {
  GOOGLE_SHEETS_SCOPES,
  GoogleSheetsConfig,
  GoogleSheetsConfigError,
} from './google-sheets.config';
import type { SheetsClient } from './sheets-client.types';

/**
 * Creates an authenticated Google Sheets v4 client for the configured service
 * account (JWT flow). The spreadsheet must be shared (Editor) with the service
 * account's `client_email`.
 *
 * Built-in retries are disabled on purpose: retry/backoff for 429 and network
 * failures is owned by the sync pipeline's retry queue, and silent library
 * retries of an `append` could write duplicate rows.
 */
export function createSheetsClient(config: GoogleSheetsConfig): SheetsClient {
  if (!config.credentials) {
    throw new GoogleSheetsConfigError(
      'cannot create a Sheets client without service account credentials',
    );
  }

  const auth = new google.auth.JWT({
    email: config.credentials.client_email,
    key: config.credentials.private_key,
    scopes: GOOGLE_SHEETS_SCOPES,
  });

  return google.sheets({
    version: 'v4',
    auth,
    timeout: config.requestTimeoutMs,
    retry: false,
  });
}
