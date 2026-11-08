import {
  findMeterConflict,
  toStateConflictException,
  STATE_CONFLICT,
  IncomingReading,
  StoredReading,
} from './meter-conflict';
import { ConflictException } from '@nestjs/common';

describe('meter-conflict (Story 14-2)', () => {
  let mockPrisma: {
    dailyLog: {
      findFirst: jest.Mock;
    };
  };

  const incoming: IncomingReading = {
    kioskId: 'KIOSK-001',
    meterVolume: 100.0,
    recordedAt: new Date('2026-10-18T10:00:00.000Z'),
  };

  beforeEach(() => {
    mockPrisma = {
      dailyLog: {
        findFirst: jest.fn(),
      },
    };
  });

  describe('findMeterConflict', () => {
    it('should return null when there are no existing records for the kiosk', async () => {
      mockPrisma.dailyLog.findFirst.mockResolvedValue(null);

      const result = await findMeterConflict(mockPrisma, incoming);
      expect(result).toBeNull();
      expect(mockPrisma.dailyLog.findFirst).toHaveBeenCalledTimes(2);
    });

    it('should return null when incoming reading fits monotonically between older and newer records', async () => {
      const older: StoredReading = {
        transactionId: 'TX-OLDER',
        meterVolume: 90.0,
        recordedAt: new Date('2026-10-18T09:00:00.000Z'),
      };
      const newer: StoredReading = {
        transactionId: 'TX-NEWER',
        meterVolume: 110.0,
        recordedAt: new Date('2026-10-18T11:00:00.000Z'),
      };

      mockPrisma.dailyLog.findFirst.mockImplementation(
        ({ where }: { where: { recordedAt: { gte?: Date; lte?: Date } } }) => {
          if (where.recordedAt?.gte) return Promise.resolve(newer);
          if (where.recordedAt?.lte) return Promise.resolve(older);
          return Promise.resolve(null);
        },
      );

      const result = await findMeterConflict(mockPrisma, incoming);
      expect(result).toBeNull();
    });

    it('should detect HIGHER_THAN_NEWER_READING when incoming meter reading exceeds newer server reading', async () => {
      const newer: StoredReading = {
        transactionId: 'TX-NEWER',
        meterVolume: 95.0, // Newer timestamp has lower reading than incoming 100.0
        recordedAt: new Date('2026-10-18T11:00:00.000Z'),
      };

      mockPrisma.dailyLog.findFirst.mockResolvedValueOnce(newer);

      const result = await findMeterConflict(mockPrisma, incoming);

      expect(result).toEqual({
        reason: 'HIGHER_THAN_NEWER_READING',
        conflictingRecord: newer,
      });
      // Should short-circuit and not check older records
      expect(mockPrisma.dailyLog.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should detect LOWER_THAN_OLDER_READING when incoming meter reading is lower than older server reading', async () => {
      const older: StoredReading = {
        transactionId: 'TX-OLDER',
        meterVolume: 105.0, // Older timestamp has higher reading than incoming 100.0
        recordedAt: new Date('2026-10-18T09:00:00.000Z'),
      };

      mockPrisma.dailyLog.findFirst
        .mockResolvedValueOnce(null) // newer check passes
        .mockResolvedValueOnce(older); // older check finds violation

      const result = await findMeterConflict(mockPrisma, incoming);

      expect(result).toEqual({
        reason: 'LOWER_THAN_OLDER_READING',
        conflictingRecord: older,
      });
      expect(mockPrisma.dailyLog.findFirst).toHaveBeenCalledTimes(2);
    });

    it('should detect conflict when an existing reading at the exact same recordedAt has different volume', async () => {
      // Same timestamp, but server already has 95.0
      const existingSameTime: StoredReading = {
        transactionId: 'TX-SAME-TIME',
        meterVolume: 95.0,
        recordedAt: new Date('2026-10-18T10:00:00.000Z'),
      };

      // Since gte matches, newer check sees 95.0 < 100.0 -> HIGHER_THAN_NEWER_READING
      mockPrisma.dailyLog.findFirst.mockResolvedValueOnce(existingSameTime);

      const result = await findMeterConflict(mockPrisma, incoming);
      expect(result).toEqual({
        reason: 'HIGHER_THAN_NEWER_READING',
        conflictingRecord: existingSameTime,
      });
    });
  });

  describe('toStateConflictException', () => {
    it('should construct a 409 ConflictException with correct payload and message', () => {
      const conflictingRecord: StoredReading = {
        transactionId: 'TX-CONFLICT-1',
        meterVolume: 80.0,
        recordedAt: new Date('2026-10-18T12:00:00.000Z'),
      };

      const exception = toStateConflictException(incoming, {
        reason: 'HIGHER_THAN_NEWER_READING',
        conflictingRecord,
      });

      expect(exception).toBeInstanceOf(ConflictException);
      expect(exception.getStatus()).toBe(409);

      const response = exception.getResponse() as Record<string, unknown>;
      expect(response).toEqual({
        statusCode: 409,
        ack: false,
        error: STATE_CONFLICT,
        reason: 'HIGHER_THAN_NEWER_READING',
        message: expect.stringContaining('is higher than newer server reading 80'),
        conflictingRecord,
      });
    });

    it('should format message properly for LOWER_THAN_OLDER_READING', () => {
      const conflictingRecord: StoredReading = {
        transactionId: 'TX-CONFLICT-2',
        meterVolume: 120.0,
        recordedAt: new Date('2026-10-18T08:00:00.000Z'),
      };

      const exception = toStateConflictException(incoming, {
        reason: 'LOWER_THAN_OLDER_READING',
        conflictingRecord,
      });

      const response = exception.getResponse() as Record<string, unknown>;
      expect(response.message).toContain('is lower than older server reading 120');
      expect(response.reason).toBe('LOWER_THAN_OLDER_READING');
    });
  });
});
