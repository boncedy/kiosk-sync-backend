import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { KioskService } from './kiosk.service';
import { IngestLogDto } from './dto/ingest-log.dto';

const MAX_EVIDENCE_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_EVIDENCE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class KioskController {
  constructor(private readonly kioskService: KioskService) {}

  // ───────────────────────────────────────────────────────────
  //  Story 02 – Ingest daily-log / meter-volume
  //  POST /api/kiosk/logs (or /daily-submission)
  //
  //  Story 14-3 – answers with a server ACK (see `sync-ack.ts`):
  //  201 for a new record, 200 when re-acknowledging a stored one.
  //  Returns tamper-evident signed receipt with SHA-256 checksum.
  // ───────────────────────────────────────────────────────────

  @Post(['logs', 'daily-submission'])
  async ingestLog(
    @Body() dto: IngestLogDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ack = await this.kioskService.ingestLog(dto);
    if (ack.duplicate) res.status(HttpStatus.OK);
    return ack;
  }

  @Post('logs/:transactionId/evidence')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_FILE_SIZE, files: 1 },
      fileFilter: (_request, file, callback) => {
        if (!ALLOWED_EVIDENCE_TYPES.has(file.mimetype)) {
          callback(
            new BadRequestException(
              'Evidence must be a JPEG, PNG, or WebP image.',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadEvidence(
    @Param('transactionId') transactionId: string,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string } | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Attach an image file in the "file" field.');
    }

    return this.kioskService.uploadEvidence(transactionId, file);
  }

  // ───────────────────────────────────────────────────────────
  //  Reconciliation – query interpreted daily-log records
  //  GET /api/kiosk/reconciliation
  //
  //  Optional query params:
  //    kioskId     e.g. KIOSK-001
  //    isAnomaly   true | false
  //    startDate   ISO-8601 (2026-11-01 or 2026-11-01T00:00:00Z)
  //    endDate     ISO-8601 (a date-only value includes the whole day)
  // ───────────────────────────────────────────────────────────

  @Get('reconciliation')
  async getReconciliation(
    @Query('kioskId') kioskId?: string,
    @Query('isAnomaly') isAnomaly?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const filters = {
      kioskId: kioskId?.trim() || undefined,
      isAnomaly: this.parseBoolean('isAnomaly', isAnomaly),
      startDate: this.parseDate('startDate', startDate),
      endDate: this.parseDate('endDate', endDate, true),
    };

    if (
      filters.startDate &&
      filters.endDate &&
      filters.startDate > filters.endDate
    ) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    const records = await this.kioskService.getReconciliationRecords(filters);
    return { count: records.length, records };
  }

  private parseBoolean(name: string, value?: string): boolean | undefined {
    if (value === undefined || value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(`${name} must be "true" or "false"`);
  }

  private parseDate(
    name: string,
    value?: string,
    endOfDay = false,
  ): Date | undefined {
    if (value === undefined || value === '') return undefined;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${name} must be a valid ISO-8601 date (e.g. 2026-11-01)`,
      );
    }

    // A date-only endDate should include that whole day, not stop at 00:00
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }

  // ───────────────────────────────────────────────────────────
  //  Existing endpoints
  // ───────────────────────────────────────────────────────────

  // POST http://localhost:3001/api/kiosk/heartbeat
  // for Ball to send Heartbeat to Server
  @Post('heartbeat')
  async receiveHeartbeat(@Body('kioskId') kioskId: string) {
    return this.kioskService.handleHeartbeat(kioskId || 'KIOSK-001');
  }

  // GET http://localhost:3001/api/kiosk/status/KIOSK-001
  // for check kiosk status or Earn to send the test
  @Get('status/:id')
  async checkStatus(@Param('id') id: string) {
    return this.kioskService.getKioskStatus(id);
  }
}
