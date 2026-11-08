import {
  canonicalizePayload,
  computePayloadChecksum,
  verifyPayloadChecksum,
  toCorruptedPayloadException,
  CORRUPTED_PAYLOAD,
} from './checksum-validator';
import { UnprocessableEntityException } from '@nestjs/common';

describe('checksum-validator (Story 14-2, SCRUM-23)', () => {
  const basePayload = {
    transactionId: 'TXN-98765-TEST',
    kioskId: 'KIOSK-001',
    meterVolume: 42.5,
    recordedAt: '2026-10-17T12:00:00.000Z',
  };

  describe('canonicalizePayload', () => {
    it('produces v1 pipe-delimited string with 4-decimal volume', () => {
      const canonical = canonicalizePayload(basePayload, 'v1');
      expect(canonical).toBe(
        'v1|kiosk:KIOSK-001|meter:42.5000|recorded:2026-10-17T12:00:00.000Z|txn:TXN-98765-TEST',
      );
    });

    it('produces legacy concatenated string', () => {
      const canonical = canonicalizePayload(basePayload, 'legacy');
      expect(canonical).toBe('TXN-98765-TESTKIOSK-00142.5');
    });

    it('handles Date objects for recordedAt', () => {
      const canonical = canonicalizePayload(
        {
          ...basePayload,
          recordedAt: new Date('2026-10-17T12:00:00.000Z'),
        },
        'v1',
      );
      expect(canonical).toBe(
        'v1|kiosk:KIOSK-001|meter:42.5000|recorded:2026-10-17T12:00:00.000Z|txn:TXN-98765-TEST',
      );
    });
  });

  describe('computePayloadChecksum', () => {
    it('computes 64-character SHA-256 hex string deterministically', () => {
      const hash1 = computePayloadChecksum(basePayload);
      const hash2 = computePayloadChecksum(basePayload);
      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(
        'a1db3b68302fcbf3afc990fef010d760f89d9ac31b44e0d364c40e723fe25c16',
      );
    });

    it('computes expected legacy SHA-256 hash', () => {
      const legacyHash = computePayloadChecksum(basePayload, 'legacy');
      expect(legacyHash).toHaveLength(64);
      expect(legacyHash).toBe(
        'afaf928fd59590c0267e8930a50d035a3f53d644c18cb5d83565ac7827e475ff',
      );
    });
  });

  describe('verifyPayloadChecksum', () => {
    it('returns true for a matching v1 checksum', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1');
      expect(verifyPayloadChecksum(basePayload, checksum)).toBe(true);
    });

    it('returns true for a matching legacy checksum', () => {
      const checksum = computePayloadChecksum(basePayload, 'legacy');
      expect(verifyPayloadChecksum(basePayload, checksum)).toBe(true);
    });

    it('returns true for version-prefixed checksums ("v1:..." and "legacy:...")', () => {
      const v1Hash = computePayloadChecksum(basePayload, 'v1');
      const legacyHash = computePayloadChecksum(basePayload, 'legacy');

      expect(verifyPayloadChecksum(basePayload, `v1:${v1Hash}`)).toBe(true);
      expect(verifyPayloadChecksum(basePayload, `legacy:${legacyHash}`)).toBe(true);
    });

    it('is case-insensitive for hex characters', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1').toUpperCase();
      expect(verifyPayloadChecksum(basePayload, checksum)).toBe(true);
    });

    it('returns false for tampered meter volume', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1');
      const tampered = { ...basePayload, meterVolume: 99.9 };
      expect(verifyPayloadChecksum(tampered, checksum)).toBe(false);
    });

    it('returns false for tampered transactionId', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1');
      const tampered = { ...basePayload, transactionId: 'TXN-FORGED' };
      expect(verifyPayloadChecksum(tampered, checksum)).toBe(false);
    });

    it('returns false for tampered kioskId', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1');
      const tampered = { ...basePayload, kioskId: 'KIOSK-ATTACKER' };
      expect(verifyPayloadChecksum(tampered, checksum)).toBe(false);
    });

    it('returns false for tampered recordedAt timestamp', () => {
      const checksum = computePayloadChecksum(basePayload, 'v1');
      const tampered = {
        ...basePayload,
        recordedAt: '2026-10-18T00:00:00.000Z',
      };
      expect(verifyPayloadChecksum(tampered, checksum)).toBe(false);
    });

    it('returns false for empty or invalid checksum strings', () => {
      expect(verifyPayloadChecksum(basePayload, '')).toBe(false);
      expect(verifyPayloadChecksum(basePayload, '   ')).toBe(false);
      expect(verifyPayloadChecksum(basePayload, 'not-a-hash')).toBe(false);
    });
  });

  describe('toCorruptedPayloadException', () => {
    it('creates an UnprocessableEntityException with 422 and error body', () => {
      const exception = toCorruptedPayloadException('Corrupted test');
      expect(exception).toBeInstanceOf(UnprocessableEntityException);
      expect(exception.getStatus()).toBe(422);

      const response = exception.getResponse() as Record<string, unknown>;
      expect(response).toEqual({
        statusCode: 422,
        ack: false,
        error: CORRUPTED_PAYLOAD,
        message: 'Corrupted test',
      });
    });
  });
});
