import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';
import { IngestLogDto } from './dto/ingest-log.dto';
import { computePayloadChecksum } from './checksum-validator';
import { computeReceiptChecksum, verifyReceiptSignature } from './receipt';

describe('KioskService', () => {
  let service: KioskService;
  let prisma: {
    kiosk: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
    dailyLog: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      kiosk: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      dailyLog: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KioskService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<KioskService>(KioskService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── ingestLog ────────────────────────────────────────────

  describe('ingestLog', () => {
    const validRaw = {
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      meterVolume: 42.5,
      recordedAt: '2026-10-16T10:00:00.000Z',
    };
    const validChecksum = computePayloadChecksum(validRaw);
    const validDto: IngestLogDto = {
      ...validRaw,
      checksum: validChecksum,
    };

    it('should create a log and return success with server timestamp and signed receipt', async () => {
      const now = new Date();
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-1',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: now,
        checksum: validChecksum,
        isSynced: true,
      });

      const result = await service.ingestLog(validDto);

      expect(result).toEqual({
        success: true,
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: false,
        logId: 'uuid-1',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: now, // server-side timestamp
        receipt: expect.any(Object),
      });

      expect(prisma.dailyLog.create).toHaveBeenCalledWith({
        data: {
          transactionId: 'TXN-001',
          kioskId: 'KIOSK-001',
          operatorId: null,
          meterVolume: 42.5,
          reportedCash: 0,
          expectedRevenue: 42.5,
          variance: -42.5,
          isAnomaly: true,
          proofImageUrl: null,
          waterType: 'COMMERCIAL',
          recordedAt: new Date('2026-10-16T10:00:00.000Z'),
          checksum: validChecksum,
        },
      });
    });

    it('should accept operatorId and reportedCash, compute server-side SHA-256 and return signed receipt', async () => {
      const now = new Date();
      const dtoWithOperator: IngestLogDto = {
        transactionId: 'TXN-OP-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OPERATOR-99',
        meterVolume: 75.25,
        reportedCash: 1250.0,
        recordedAt: '2026-10-16T12:00:00.000Z',
      };

      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-op-1',
        transactionId: dtoWithOperator.transactionId,
        kioskId: dtoWithOperator.kioskId,
        meterVolume: dtoWithOperator.meterVolume,
        recordedAt: new Date(dtoWithOperator.recordedAt),
        createdAt: now,
        checksum: null,
        isSynced: true,
      });

      const result = await service.ingestLog(dtoWithOperator);

      expect(result.success).toBe(true);
      expect(result.operatorId).toBe('OPERATOR-99');
      expect(result.reportedCash).toBe(1250.0);
      expect(result.receipt).toBeDefined();

      const expectedChecksum = computeReceiptChecksum({
        kioskId: 'KIOSK-001',
        operatorId: 'OPERATOR-99',
        meterVolume: 75.25,
        reportedCash: 1250.0,
        recordedAt: '2026-10-16T12:00:00.000Z',
      });

      expect(result.receipt!.checksum).toBe(expectedChecksum);
      expect(result.receipt!.hash).toBe(expectedChecksum);
      expect(result.receipt!.operatorId).toBe('OPERATOR-99');
      expect(result.receipt!.reportedCash).toBe(1250.0);
      expect(result.receipt!.meterVolume).toBe(75.25);
      expect(result.receipt!.kioskId).toBe('KIOSK-001');
      expect(result.receipt!.algorithm).toBe('SHA-256');
      expect(result.receipt!.signature).toMatch(/^[0-9a-f]{64}$/);

      // Verify cryptographic signature
      expect(
        verifyReceiptSignature(
          result.receipt!.checksum,
          result.receipt!.signature,
        ),
      ).toBe(true);
    });

    it('should set checksum to null when not provided', async () => {
      const dtoNoChecksum: IngestLogDto = {
        transactionId: 'TXN-002',
        kioskId: 'KIOSK-001',
        meterVolume: 10,
        recordedAt: '2026-10-16T10:00:00.000Z',
      };

      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-2',
        transactionId: 'TXN-002',
        kioskId: 'KIOSK-001',
        meterVolume: 10,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: new Date(),
        checksum: null,
        isSynced: true,
      });

      await service.ingestLog(dtoNoChecksum);

      expect(prisma.dailyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ checksum: null }),
        }),
      );
    });

    it('should throw UnprocessableEntityException when checksum mismatches payload (Story 14-2)', async () => {
      const corruptedDto: IngestLogDto = {
        ...validRaw,
        checksum: 'f'.repeat(64),
      };

      await expect(service.ingestLog(corruptedDto)).rejects.toThrow(
        UnprocessableEntityException,
      );

      try {
        await service.ingestLog(corruptedDto);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UnprocessableEntityException);
        const res = (err as UnprocessableEntityException).getResponse() as Record<string, unknown>;
        expect(res.statusCode).toBe(422);
        expect(res.ack).toBe(false);
        expect(res.error).toBe('CORRUPTED_PAYLOAD');
      }

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should accept valid legacy checksum format (Story 14-2)', async () => {
      const legacyChecksum = computePayloadChecksum(validRaw, 'legacy');
      const legacyDto: IngestLogDto = {
        ...validRaw,
        checksum: legacyChecksum,
      };

      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-legacy',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: new Date(),
        checksum: legacyChecksum,
        isSynced: true,
      });

      const result = await service.ingestLog(legacyDto);
      expect(result.success).toBe(true);
      expect(prisma.dailyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ checksum: legacyChecksum }),
        }),
      );
    });

    it('should accept valid version-prefixed checksum (Story 14-2)', async () => {
      const prefixedChecksum = `v1:${validChecksum}`;
      const prefixedDto: IngestLogDto = {
        ...validRaw,
        checksum: prefixedChecksum,
      };

      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-prefixed',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: new Date(),
        checksum: prefixedChecksum,
        isSynced: true,
      });

      const result = await service.ingestLog(prefixedDto);
      expect(result.success).toBe(true);
    });

    it('should throw NotFoundException when kiosk does not exist', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(null);

      await expect(service.ingestLog(validDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.ingestLog(validDto)).rejects.toThrow(
        'Kiosk "KIOSK-001" not found',
      );

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    // ─── Story 14-3 – server ACK confirmation ───────────────

    const storedLog = {
      id: 'existing-uuid',
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      meterVolume: 42.5,
      recordedAt: new Date('2026-10-16T10:00:00.000Z'),
      createdAt: new Date('2026-10-16T10:00:05.000Z'),
      checksum: validChecksum,
      isSynced: true,
    };

    it('should re-acknowledge an identical retry of a stored transactionId without inserting (Story 14-3)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(storedLog);

      const result = await service.ingestLog(validDto);

      expect(result).toEqual({
        success: true,
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: true,
        logId: 'existing-uuid',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: storedLog.recordedAt,
        createdAt: storedLog.createdAt, // time of the first, successful upload
        receipt: expect.any(Object),
      });
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
      expect(prisma.dailyLog.findFirst).not.toHaveBeenCalled();
    });

    it('should throw ConflictException (DUPLICATE_TRANSACTION, ack: false) when a stored transactionId arrives with a different reading', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue({
        ...storedLog,
        meterVolume: 40,
      });

      const err: unknown = await service.ingestLog(validDto).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      const res = (err as ConflictException).getResponse() as Record<string, unknown>;
      expect(res.ack).toBe(false);
      expect(res.error).toBe('DUPLICATE_TRANSACTION');
      expect(res.message).toContain('transactionId "TXN-001" already exists');
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should re-acknowledge when a parallel retry wins the insert race (P2002)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique
        .mockResolvedValueOnce(null) // not stored yet when checked
        .mockResolvedValueOnce(storedLog); // stored by the winner
      prisma.dailyLog.create.mockRejectedValue({ code: 'P2002' });

      const result = await service.ingestLog(validDto);

      expect(result).toMatchObject({
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: true,
        logId: 'existing-uuid',
      });
    });

    it('should throw ConflictException (STATE_CONFLICT) when reading is higher than newer server state', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      // Newer record at 11:00 with meterVolume 30, but incoming is at 10:00 with meterVolume 42.5
      prisma.dailyLog.findFirst.mockImplementation(({ where }: { where: { recordedAt: { gte?: Date; lte?: Date } } }) => {
        if (where.recordedAt?.gte) {
          return Promise.resolve({
            transactionId: 'TXN-NEWER',
            meterVolume: 30.0,
            recordedAt: new Date('2026-10-16T11:00:00.000Z'),
          });
        }
        return Promise.resolve(null);
      });

      await expect(service.ingestLog(validDto)).rejects.toThrow(
        ConflictException,
      );

      try {
        await service.ingestLog(validDto);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.error).toBe('STATE_CONFLICT');
        expect(res.reason).toBe('HIGHER_THAN_NEWER_READING');
      }

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException (STATE_CONFLICT) when reading is lower than older server state', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      // Older record at 09:00 with meterVolume 50, but incoming is at 10:00 with meterVolume 42.5
      prisma.dailyLog.findFirst.mockImplementation(({ where }: { where: { recordedAt: { gte?: Date; lte?: Date } } }) => {
        if (where.recordedAt?.lte) {
          return Promise.resolve({
            transactionId: 'TXN-OLDER',
            meterVolume: 50.0,
            recordedAt: new Date('2026-10-16T09:00:00.000Z'),
          });
        }
        return Promise.resolve(null);
      });

      try {
        await service.ingestLog(validDto);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.error).toBe('STATE_CONFLICT');
        expect(res.reason).toBe('LOWER_THAN_OLDER_READING');
      }

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should accept a lower daily volume without applying cumulative-meter conflict checks', async () => {
      const dailyVolumeDto: IngestLogDto = {
        ...validRaw,
        transactionId: 'TXN-DAILY-VOLUME-001',
        meterVolume: 12.5,
        readingType: 'DAILY_VOLUME',
      };
      const recordedAt = new Date(dailyVolumeDto.recordedAt);
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.findFirst.mockResolvedValue({
        transactionId: 'TXN-OLDER',
        meterVolume: 50,
        recordedAt: new Date('2026-10-16T09:00:00.000Z'),
      });
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-daily-volume-1',
        transactionId: dailyVolumeDto.transactionId,
        kioskId: dailyVolumeDto.kioskId,
        meterVolume: dailyVolumeDto.meterVolume,
        recordedAt,
        createdAt: new Date(),
        checksum: null,
        isSynced: true,
      });

      const result = await service.ingestLog(dailyVolumeDto);

      expect(result.meterVolume).toBe(12.5);
      expect(prisma.dailyLog.findFirst).not.toHaveBeenCalled();
      expect(prisma.dailyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meterVolume: 12.5,
            transactionId: 'TXN-DAILY-VOLUME-001',
          }),
        }),
      );
    });
  });

  // ─── handleHeartbeat ──────────────────────────────────────

  describe('handleHeartbeat', () => {
    it('should upsert the kiosk and return success', async () => {
      const now = new Date();
      prisma.kiosk.upsert.mockResolvedValue({
        id: 'KIOSK-001',
        status: 'ONLINE',
        lastHeartbeat: now,
      });

      const result = await service.handleHeartbeat('KIOSK-001');

      expect(result).toEqual({
        success: true,
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        timestamp: now,
      });
    });
  });
});
