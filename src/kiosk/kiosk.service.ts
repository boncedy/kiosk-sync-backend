import { PrismaService } from '../prisma.service';
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ImgbbService, EvidenceStorageUnavailableError } from './imgbb.service';
import { IngestLogDto } from './dto/ingest-log.dto';
import {
  findMeterConflict,
  toStateConflictException,
  IncomingReading,
} from './meter-conflict';
import {
  verifyPayloadChecksum,
  toCorruptedPayloadException,
} from './checksum-validator';
import {
  isSameReading,
  toDuplicateTransactionException,
  toSyncAck,
  StoredLog,
  SyncAck,
} from './sync-ack';
import { generateSignedReceipt } from './receipt';
import type { ReadingTypeDto } from './dto/ingest-log.dto';

// TODO: adjust these to your real business rules
const PRICE_PER_UNIT = 1; // revenue per unit of meterVolume
const ANOMALY_TOLERANCE = 0.05; // allowed |variance| / expectedRevenue
const MAX_EVIDENCE_FILE_SIZE = 5 * 1024 * 1024;

const EVIDENCE_FILE_TYPES = {
  'image/jpeg': {
    extension: 'jpg',
    matches: (buffer: Buffer) =>
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },
  'image/png': {
    extension: 'png',
    matches: (buffer: Buffer) =>
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    extension: 'webp',
    matches: (buffer: Buffer) =>
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP',
  },
} as const;

export interface EvidenceUploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/**
 * Proof photos are hosted by imgBB, so the persisted URL points at their CDN.
 * Only https URLs on imgBB's own hosts are accepted to stop arbitrary hosts
 * being stored as "evidence".
 */
const IMGBB_IMAGE_HOSTS = new Set(['i.ibb.co', 'ibb.co']);

export function isImgbbImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      IMGBB_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
      url.pathname.replace(/^\/+/, '').length > 0
    );
  } catch {
    return false;
  }
}

/** `proofImageUrl` must be a URL the evidence upload route could have produced. */
export function isAcceptableProofImageUrl(proofImageUrl: string): boolean {
  return isImgbbImageUrl(proofImageUrl);
}

@Injectable()
export class KioskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KioskService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly imgbb: ImgbbService = new ImgbbService(),
  ) {}

  /**
   * Validates the photo, hands the bytes to imgBB, and returns the public URL
   * that the operator client stores on the submission as `proofImageUrl`.
   * Nothing is written to PostgreSQL here.
   */
  async uploadEvidence(
    transactionId: string,
    file: EvidenceUploadFile,
  ): Promise<{ proofImageUrl: string }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) {
      throw new BadRequestException('Invalid transactionId for evidence upload.');
    }
    if (file.buffer.length === 0) {
      throw new BadRequestException('Evidence image is empty.');
    }
    if (file.buffer.length > MAX_EVIDENCE_FILE_SIZE) {
      throw new PayloadTooLargeException('Evidence image must be 5 MB or smaller.');
    }

    const imageType =
      EVIDENCE_FILE_TYPES[file.mimetype as keyof typeof EVIDENCE_FILE_TYPES];
    if (!imageType || !imageType.matches(file.buffer)) {
      throw new BadRequestException(
        'Evidence must be a valid JPEG, PNG, or WebP image.',
      );
    }

    if (!this.imgbb.isConfigured()) {
      throw new ServiceUnavailableException(
        'Evidence storage is not configured on the server.',
      );
    }

    try {
      const uploaded = await this.imgbb.upload(
        file.buffer,
        `kiosk-${transactionId}.${imageType.extension}`,
        file.mimetype,
      );
      return { proofImageUrl: uploaded.url };
    } catch (error) {
      if (error instanceof EvidenceStorageUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }

  onModuleInit() {
    // Proactively sweeps kiosks in background every 5s to mark stale kiosks as OFFLINE
    if (process.env.NODE_ENV !== 'test') {
      this.sweepTimer = setInterval(() => {
        this.sweepStaleKiosks().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Background sweep check error: ${msg}`);
        });
      }, 5000);
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Proactively sweeps all kiosks in the database and marks any kiosk whose
   * heartbeat has ceased for more than 30 seconds as OFFLINE.
   */
  async sweepStaleKiosks(): Promise<number> {
    if (!this.prisma?.kiosk?.updateMany) return 0;
    const cutoff = new Date(Date.now() - 30 * 1000);
    const result = await this.prisma.kiosk.updateMany({
      where: {
        status: 'ONLINE',
        lastHeartbeat: {
          lt: cutoff,
        },
      },
      data: {
        status: 'OFFLINE',
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Background sweeper: marked ${result.count} stale kiosk(s) as OFFLINE in database`,
      );
    }

    return result.count;
  }

  // ───────────────────────────────────────────────────────────
  //  Story 02 – Ingest a daily-log / meter-volume reading
  // ───────────────────────────────────────────────────────────

  /**
   * Persist a meter-volume reading sent by a kiosk.
   *
   * - Recomputes and verifies SHA-256 hash against `checksum` (Story 14-2).
   * - Accepts `operatorId` and `reportedCash`.
   * - Generates server-side SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt).
   * - Validates that the referenced kiosk exists.
   * - Idempotency: an identical retry of a stored `transactionId` is
   *   acknowledged again instead of inserted twice; a different reading
   *   under the same `transactionId` is rejected (Story 14-3, see `sync-ack.ts`).
   * - Rejects readings that conflict with server state for the same kiosk
   *   (Story 14-2, see `meter-conflict.ts`).
   * - Computes expectedRevenue / variance / isAnomaly for reconciliation.
   * - Generates the server-side `createdAt` timestamp automatically
   *   via Prisma's `@default(now())`.
   * - Returns an explicit ACK (`ack: true, status: "SYNCHRONIZED"`) and a signed receipt object.
   */
  async ingestLog(dto: IngestLogDto): Promise<SyncAck> {
    // 1. Story 14-2 – Verify SHA-256 checksum if provided
    if (dto.checksum !== undefined && dto.checksum !== null) {
      const isValid = verifyPayloadChecksum(
        {
          transactionId: dto.transactionId,
          kioskId: dto.kioskId,
          meterVolume: dto.meterVolume,
          recordedAt: dto.recordedAt,
          operatorId: dto.operatorId,
          reportedCash: dto.reportedCash,
        },
        dto.checksum,
      );

      if (!isValid) {
        this.logger.warn(
          `Checksum mismatch for kiosk ${dto.kioskId} (txn: ${dto.transactionId})`,
        );
        throw toCorruptedPayloadException(
          `Checksum mismatch for transaction "${dto.transactionId}". Payload is corrupted or has been tampered with.`,
        );
      }
    }

    // 2. Verify the kiosk exists
    const kiosk = await this.prisma.kiosk.findUnique({
      where: { id: dto.kioskId },
    });

    if (!kiosk) {
      throw new NotFoundException(
        `Kiosk "${dto.kioskId}" not found. Register the kiosk first.`,
      );
    }

    const incoming: IncomingReading = {
      kioskId: dto.kioskId,
      meterVolume: dto.meterVolume,
      recordedAt: new Date(dto.recordedAt),
    };

    // 3. Idempotency – a retry whose first ACK was lost gets the ACK again
    const existing = await this.prisma.dailyLog.findUnique({
      where: { transactionId: dto.transactionId },
    });

    if (existing) {
      return this.acknowledgeExisting(existing, incoming, dto);
    }

    // 4. Story 14-2 – reject readings that conflict with server state
    const readingType: ReadingTypeDto =
      dto.readingType ?? 'CUMULATIVE_METER';
    const conflict =
      readingType === 'DAILY_VOLUME'
        ? null
        : await findMeterConflict(this.prisma, incoming);

    if (conflict) {
      this.logger.warn(
        `State conflict for kiosk ${dto.kioskId} (txn: ${dto.transactionId}): ${conflict.reason}`,
      );
      throw toStateConflictException(incoming, conflict);
    }

    if (
      dto.proofImageUrl &&
      !isAcceptableProofImageUrl(dto.proofImageUrl)
    ) {
      throw new BadRequestException(
        'proofImageUrl must be an imgBB image URL returned by the evidence upload endpoint.',
      );
    }

    // 5. Reconciliation figures (reportedCash is optional in the DTO
    //    but required in the database, so default it to 0)
    const reportedCash = dto.reportedCash ?? 0;
    const expectedRevenue =
      dto.expectedRevenue ?? dto.meterVolume * PRICE_PER_UNIT;
    const variance = dto.variance ?? reportedCash - expectedRevenue;
    const isAnomaly =
      dto.isAnomaly ??
      (expectedRevenue === 0
        ? reportedCash !== 0
        : Math.abs(variance) / expectedRevenue > ANOMALY_TOLERANCE);

    // 6. Create the log – server timestamp is generated by Prisma/DB
    try {
      const log = await this.prisma.dailyLog.create({
        data: {
          transactionId: dto.transactionId,
          kioskId: dto.kioskId,
          operatorId: dto.operatorId ?? null,
          meterVolume: dto.meterVolume,
          reportedCash,
          expectedRevenue,
          variance,
          isAnomaly,
          proofImageUrl: dto.proofImageUrl ?? null,
          waterType: dto.waterType ?? 'COMMERCIAL',
          recordedAt: new Date(dto.recordedAt),
          checksum: dto.checksum ?? null,
        },
      });

      this.logger.log(
        `Ingested log ${log.id} for kiosk ${log.kioskId} (txn: ${log.transactionId})`,
      );

      const receipt = generateSignedReceipt({
        kioskId: dto.kioskId,
        operatorId: dto.operatorId,
        meterVolume: dto.meterVolume,
        reportedCash: dto.reportedCash,
        recordedAt: dto.recordedAt,
        transactionId: dto.transactionId,
      });

      return toSyncAck(log, false, receipt, dto.operatorId, dto.reportedCash);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        // A parallel retry of the same transaction was stored first
        const winner = await this.prisma.dailyLog.findUnique({
          where: { transactionId: dto.transactionId },
        });
        if (winner) return this.acknowledgeExisting(winner, incoming, dto);
        throw toDuplicateTransactionException(dto.transactionId);
      }
      throw err;
    }
  }

  /**
   * Story 14-3 – re-acknowledge a `transactionId` that is already stored.
   * Only an identical reading counts as a retry; anything else is a conflict.
   */
  private acknowledgeExisting(
    existing: StoredLog,
    incoming: IncomingReading,
    dto?: IngestLogDto,
  ): SyncAck {
    if (!isSameReading(existing, incoming)) {
      this.logger.warn(
        `Transaction ${existing.transactionId} reused with a different reading for kiosk ${incoming.kioskId}`,
      );
      throw toDuplicateTransactionException(existing.transactionId);
    }

    this.logger.log(
      `Re-acknowledged log ${existing.id} for kiosk ${existing.kioskId} (txn: ${existing.transactionId})`,
    );

    const receipt = generateSignedReceipt({
      kioskId: existing.kioskId,
      operatorId: dto?.operatorId,
      meterVolume: existing.meterVolume,
      reportedCash: dto?.reportedCash,
      recordedAt: existing.recordedAt,
      transactionId: existing.transactionId,
    });

    return toSyncAck(
      existing,
      true,
      receipt,
      dto?.operatorId,
      dto?.reportedCash,
    );
  }

  // ───────────────────────────────────────────────────────────
  //  Heartbeat
  // ───────────────────────────────────────────────────────────

  // Receive Heartbeat from client and update status to ONLINE
  async handleHeartbeat(kioskId: string) {
    const now = new Date();

    const kiosk = await this.prisma.kiosk.upsert({
      where: { id: kioskId },
      update: {
        status: 'ONLINE',
        lastHeartbeat: now,
      },
      create: {
        id: kioskId,
        status: 'ONLINE',
        lastHeartbeat: now,
      },
    });

    return {
      success: true,
      kioskId: kiosk.id,
      status: kiosk.status,
      timestamp: kiosk.lastHeartbeat,
    };
  }

  // Check Kiosk status (If disconnected 30 sec, update status to OFFLINE)
  async getKioskStatus(kioskId: string) {
    const kiosk = await this.prisma.kiosk.findUnique({
      where: { id: kioskId },
    });

    if (!kiosk || !kiosk.lastHeartbeat) {
      return { kioskId, status: 'OFFLINE', lastHeartbeat: null };
    }

    const diffSeconds = (Date.now() - kiosk.lastHeartbeat.getTime()) / 1000;
    const currentStatus = diffSeconds > 30 ? 'OFFLINE' : 'ONLINE';

    // If disconnected 30 sec, update status to OFFLINE
    if (currentStatus === 'OFFLINE' && kiosk.status !== 'OFFLINE') {
      await this.prisma.kiosk.update({
        where: { id: kioskId },
        data: { status: 'OFFLINE' },
      });
    }

    return {
      kioskId: kiosk.id,
      status: currentStatus,
      lastHeartbeat: kiosk.lastHeartbeat,
      secondsSinceLastPing: Math.round(diffSeconds),
    };
  }

  // ───────────────────────────────────────────────────────────
  //  Reconciliation – query interpreted daily-log records
  //  Used by GET /api/kiosk/reconciliation
  // ───────────────────────────────────────────────────────────
  async getReconciliationRecords(filters: {
    kioskId?: string;
    isAnomaly?: boolean;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { kioskId, isAnomaly, startDate, endDate } = filters;

    return this.prisma.dailyLog.findMany({
      where: {
        ...(kioskId && { kioskId }),
        ...(isAnomaly !== undefined && { isAnomaly }),
        ...(startDate || endDate
          ? {
              recordedAt: {
                ...(startDate && { gte: startDate }),
                ...(endDate && { lte: endDate }),
              },
            }
          : {}),
      },
      select: {
        id: true,
        transactionId: true,
        kioskId: true,
        operatorId: true,
        meterVolume: true,
        reportedCash: true,
        expectedRevenue: true,
        variance: true,
        isAnomaly: true,
        proofImageUrl: true,
        waterType: true,
        isReadByManager: true,
        recordedAt: true,
        createdAt: true,
      },
      orderBy: { recordedAt: 'desc' },
    });
  }
}
