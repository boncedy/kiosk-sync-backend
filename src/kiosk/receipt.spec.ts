import * as crypto from 'crypto';
import {
  buildReceiptChecksumString,
  computeReceiptChecksum,
  generateSignedReceipt,
  signReceiptChecksum,
  verifyReceiptSignature,
} from './receipt';

describe('Receipt Generator & Checksum (Tamper-Evident Receipts)', () => {
  const sample = {
    kioskId: 'KIOSK-001',
    operatorId: 'OP-42',
    meterVolume: 125.5,
    reportedCash: 500,
    recordedAt: '2026-11-04T10:00:00.000Z',
  };

  describe('buildReceiptChecksumString', () => {
    it('concatenates kioskId + operatorId + meterVolume + reportedCash + recordedAt', () => {
      const result = buildReceiptChecksumString(sample);
      expect(result).toBe('KIOSK-001OP-42125.55002026-11-04T10:00:00.000Z');
    });

    it('handles zero reportedCash correctly', () => {
      const result = buildReceiptChecksumString({
        ...sample,
        reportedCash: 0,
      });
      expect(result).toBe('KIOSK-001OP-42125.502026-11-04T10:00:00.000Z');
    });

    it('handles missing operatorId and reportedCash gracefully', () => {
      const result = buildReceiptChecksumString({
        kioskId: 'KIOSK-002',
        meterVolume: 50.0,
        recordedAt: '2026-11-04T10:00:00.000Z',
      });
      expect(result).toBe('KIOSK-002502026-11-04T10:00:00.000Z');
    });

    it('formats Date instance into ISO string', () => {
      const date = new Date('2026-11-04T12:30:00.000Z');
      const result = buildReceiptChecksumString({
        ...sample,
        recordedAt: date,
      });
      expect(result).toBe('KIOSK-001OP-42125.55002026-11-04T12:30:00.000Z');
    });
  });

  describe('computeReceiptChecksum', () => {
    it('computes exact SHA-256 hash of the canonical message', () => {
      const expectedMessage = 'KIOSK-001OP-42125.55002026-11-04T10:00:00.000Z';
      const expectedHash = crypto
        .createHash('sha256')
        .update(expectedMessage)
        .digest('hex');

      const hash = computeReceiptChecksum(sample);
      expect(hash).toBe(expectedHash);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different hash if any field is tampered with', () => {
      const originalHash = computeReceiptChecksum(sample);

      // Tamper operatorId
      const tamperedOperator = computeReceiptChecksum({
        ...sample,
        operatorId: 'OP-43',
      });
      expect(tamperedOperator).not.toBe(originalHash);

      // Tamper reportedCash
      const tamperedCash = computeReceiptChecksum({
        ...sample,
        reportedCash: 501,
      });
      expect(tamperedCash).not.toBe(originalHash);

      // Tamper meterVolume
      const tamperedMeter = computeReceiptChecksum({
        ...sample,
        meterVolume: 125.51,
      });
      expect(tamperedMeter).not.toBe(originalHash);

      // Tamper kioskId
      const tamperedKiosk = computeReceiptChecksum({
        ...sample,
        kioskId: 'KIOSK-002',
      });
      expect(tamperedKiosk).not.toBe(originalHash);

      // Tamper recordedAt
      const tamperedDate = computeReceiptChecksum({
        ...sample,
        recordedAt: '2026-11-04T10:00:01.000Z',
      });
      expect(tamperedDate).not.toBe(originalHash);
    });
  });

  describe('signReceiptChecksum & verifyReceiptSignature', () => {
    const testSecret = 'test-secret-key-12345';

    it('generates a valid HMAC-SHA256 signature and verifies it successfully', () => {
      const checksum = computeReceiptChecksum(sample);
      const signature = signReceiptChecksum(checksum, testSecret);

      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyReceiptSignature(checksum, signature, testSecret)).toBe(true);
    });

    it('rejects signature if checksum or secret is tampered', () => {
      const checksum = computeReceiptChecksum(sample);
      const signature = signReceiptChecksum(checksum, testSecret);

      // Different checksum
      expect(
        verifyReceiptSignature('0'.repeat(64), signature, testSecret),
      ).toBe(false);

      // Different secret
      expect(
        verifyReceiptSignature(checksum, signature, 'wrong-secret'),
      ).toBe(false);

      // Corrupted signature
      const corruptedSig = 'a' + signature.slice(1);
      expect(
        verifyReceiptSignature(checksum, corruptedSig, testSecret),
      ).toBe(false);
    });
  });

  describe('generateSignedReceipt', () => {
    it('returns a complete signed receipt object with all required fields', () => {
      const receipt = generateSignedReceipt({
        ...sample,
        transactionId: 'TXN-TEST-1',
      });

      expect(receipt.receiptId).toMatch(/^RCPT-/);
      expect(receipt.transactionId).toBe('TXN-TEST-1');
      expect(receipt.kioskId).toBe('KIOSK-001');
      expect(receipt.operatorId).toBe('OP-42');
      expect(receipt.meterVolume).toBe(125.5);
      expect(receipt.reportedCash).toBe(500);
      expect(receipt.recordedAt).toBe('2026-11-04T10:00:00.000Z');
      expect(receipt.checksum).toBe(computeReceiptChecksum(sample));
      expect(receipt.hash).toBe(receipt.checksum);
      expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.algorithm).toBe('SHA-256');
      expect(receipt.issuedAt).toBeDefined();
      expect(receipt.signedAt).toBe(receipt.issuedAt);

      // Verify the generated signature
      expect(verifyReceiptSignature(receipt.checksum, receipt.signature)).toBe(true);
    });
  });
});
