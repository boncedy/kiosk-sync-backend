import { Module } from '@nestjs/common';
import { createSheetsClient } from './google-sheets.client';
import { loadGoogleSheetsConfig } from './google-sheets.config';
import {
  GOOGLE_SHEETS_CLIENT_FACTORY,
  GOOGLE_SHEETS_CONFIG,
  GoogleSheetsService,
} from './google-sheets.service';

/**
 * Story 03 – provides `GoogleSheetsService` configured from environment
 * variables (see `.env.example`). Import this module wherever the sync
 * pipeline needs to push rows to Google Sheets.
 */
@Module({
  providers: [
    {
      provide: GOOGLE_SHEETS_CONFIG,
      useFactory: () => loadGoogleSheetsConfig(process.env),
    },
    { provide: GOOGLE_SHEETS_CLIENT_FACTORY, useValue: createSheetsClient },
    GoogleSheetsService,
  ],
  exports: [GoogleSheetsService],
})
export class GoogleSheetsModule {}
