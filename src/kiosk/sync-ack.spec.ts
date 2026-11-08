import {
  isSameReading,
  toDuplicateTransactionException,
  toSyncAck,
  DUPLICATE_TRANSACTION,
  SYNCHRONIZED,
  StoredLog,
} from './sync-ack';
import { IncomingReading } from './meter-conflict';
import { ConflictException } from '@nestjs/common';

describe('sync-ack (Story 14-3)', () => {
  const stored: StoredLog = {
    id: 'log-1',
    transactionId: 'TXN-ACK-1',
    kioskId: 'KIOSK-001',
    meterVolume: 125.5,
    recordedAt: new Date('2026-10-14T10:05:00.000Z'),
    createdAt: new Date('2026-10-14T10:05:01.000Z'),
  };

  const retry: IncomingReading = {
    kioskId: 'KIOSK-001',
    meterVolume: 125.5,
    recordedAt: new Date('2026-10-14T10:05:00.000Z'),
  };

  describe('toSyncAck', () => {
    it('should build the SYNCHRONIZED ACK body from the stored record', () => {
      expect(toSyncAck(stored, false)).toEqual({
        success: true,
        ack: true,
        status: SYNCHRONIZED,
        duplicate: false,
        logId: 'log-1',
        transactionId: 'TXN-ACK-1',
        kioskId: 'KIOSK-001',
        meterVolume: 125.5,
        recordedAt: stored.recordedAt,
        createdAt: stored.createdAt,
      });
    });

    it('should flag a re-acknowledged record as duplicate', () => {
      const ack = toSyncAck(stored, true);
      expect(ack.duplicate).toBe(true);
      expect(ack.ack).toBe(true);
      expect(ack.status).toBe(SYNCHRONIZED);
    });
  });

  describe('isSameReading', () => {
    it('should accept an identical retry', () => {
      expect(isSameReading(stored, retry)).toBe(true);
    });

    it('should accept the same instant written in a different timezone offset', () => {
      expect(
        isSameReading(stored, {
          ...retry,
          recordedAt: new Date('2026-10-14T17:05:00+07:00'),
        }),
      ).toBe(true);
    });

    it.each([
      ['meterVolume', { meterVolume: 125.51 }],
      ['recordedAt', { recordedAt: new Date('2026-10-14T10:05:00.001Z') }],
      ['kioskId', { kioskId: 'KIOSK-002' }],
    ])('should reject a different %s', (_label, change) => {
      expect(isSameReading(stored, { ...retry, ...change })).toBe(false);
    });
  });

  describe('toDuplicateTransactionException', () => {
    it('should construct a 409 with ack: false and DUPLICATE_TRANSACTION', () => {
      const exception = toDuplicateTransactionException('TXN-ACK-1');

      expect(exception).toBeInstanceOf(ConflictException);
      expect(exception.getStatus()).toBe(409);
      expect(exception.getResponse()).toEqual({
        statusCode: 409,
        ack: false,
        error: DUPLICATE_TRANSACTION,
        message: expect.stringContaining(
          'A log with transactionId "TXN-ACK-1" already exists.',
        ),
      });
    });
  });
});
