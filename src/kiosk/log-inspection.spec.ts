import {
  computePayloadChecksum,
  computeReceiptChecksum,
} from './checksum-validator';
import {
  CHECKSUM_MISMATCH,
  NO_CHECKSUM,
  VERIFIED,
  toLogInspection,
  verifyStoredChecksum,
  type InspectableLog,
} from './log-inspection';

const NOW = new Date('2026-11-06T08:00:00.000Z');

const reading = {
  transactionId: 'TXN-HIST-001',
  kioskId: 'KIOSK-001',
  meterVolume: 150.75,
  recordedAt: new Date('2026-11-04T10:00:00.000Z'),
};

const v1 = computePayloadChecksum(reading, 'v1');
const legacy = computePayloadChecksum(reading, 'legacy');

/** Changes one hex digit, keeping a valid 64-char hash. */
const flipLastHexChar = (hex: string) =>
  hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');

const storedLog = (
  overrides: Partial<InspectableLog> = {},
): InspectableLog => ({
  id: 'log-1',
  ...reading,
  createdAt: new Date('2026-11-04T10:00:01.000Z'),
  checksum: v1,
  ...overrides,
});

describe('verifyStoredChecksum (Story 05 – historical log inspection)', () => {
  describe('untouched rows verify', () => {
    it.each<[string, string, string]>([
      ['an unprefixed v1 checksum', v1, 'v1'],
      ['a "v1:" prefixed checksum', `v1:${v1}`, 'v1'],
      ['an unprefixed legacy checksum', legacy, 'legacy'],
      ['a "legacy:" prefixed checksum', `legacy:${legacy}`, 'legacy'],
      [
        'an upper-case checksum with whitespace',
        `  ${v1.toUpperCase()} `,
        'v1',
      ],
    ])('accepts %s', (_label, checksum, format) => {
      const result = verifyStoredChecksum(storedLog({ checksum }), NOW);

      expect(result).toMatchObject({
        status: VERIFIED,
        algorithm: 'SHA-256',
        format,
        storedChecksum: checksum.trim(),
        verifiedAt: NOW.toISOString(),
      });
    });

    it('accepts a receipt-format checksum when operatorId and reportedCash are stored', () => {
      const receiptFields = { operatorId: 'OP-7', reportedCash: 2450 };
      const checksum = computeReceiptChecksum({ ...reading, ...receiptFields });

      const result = verifyStoredChecksum(
        storedLog({ ...receiptFields, checksum }),
        NOW,
      );

      expect(result.status).toBe(VERIFIED);
      expect(result.format).toBe('receipt');
    });

    it('returns the recomputed hash so the manager can compare it', () => {
      expect(verifyStoredChecksum(storedLog(), NOW).recomputedChecksum).toBe(
        v1,
      );
    });
  });

  describe('rows changed after submission are flagged', () => {
    it.each<[string, Partial<InspectableLog>]>([
      ['meterVolume edited', { meterVolume: 999.99 }],
      [
        'recordedAt edited',
        { recordedAt: new Date('2026-11-04T09:00:00.000Z') },
      ],
      ['kioskId edited', { kioskId: 'KIOSK-002' }],
      ['transactionId edited', { transactionId: 'TXN-HIST-999' }],
      ['stored checksum overwritten', { checksum: flipLastHexChar(v1) }],
    ])('detects %s', (_label, tamper) => {
      const result = verifyStoredChecksum(storedLog(tamper), NOW);

      expect(result.status).toBe(CHECKSUM_MISMATCH);
      expect(result.recomputedChecksum).not.toBe(result.storedChecksum);
    });

    it('reports what the current row hashes to under v1', () => {
      const result = verifyStoredChecksum(
        storedLog({ meterVolume: 999.99 }),
        NOW,
      );

      expect(result.format).toBe('v1');
      expect(result.storedChecksum).toBe(v1);
      expect(result.recomputedChecksum).toBe(
        computePayloadChecksum({ ...reading, meterVolume: 999.99 }, 'v1'),
      );
    });

    it('honours a version prefix instead of trying other formats', () => {
      const result = verifyStoredChecksum(
        storedLog({ checksum: `legacy:${v1}` }),
        NOW,
      );

      expect(result).toMatchObject({
        status: CHECKSUM_MISMATCH,
        format: 'legacy',
        recomputedChecksum: legacy,
      });
    });
  });

  describe('rows without a checksum', () => {
    it.each<[string, string | null]>([
      ['null', null],
      ['empty', ''],
      ['blank', '   '],
    ])('are not verifiable when the checksum is %s', (_label, checksum) => {
      expect(verifyStoredChecksum(storedLog({ checksum }), NOW)).toEqual({
        status: NO_CHECKSUM,
        algorithm: 'SHA-256',
        format: null,
        storedChecksum: null,
        recomputedChecksum: null,
        verifiedAt: NOW.toISOString(),
      });
    });
  });
});

describe('toLogInspection', () => {
  it('returns the stored fields with the verification result', () => {
    const inspection = toLogInspection(storedLog(), NOW);

    expect(inspection.log).toEqual({
      id: 'log-1',
      ...reading,
      createdAt: new Date('2026-11-04T10:00:01.000Z'),
      operatorId: null,
      reportedCash: null,
      expectedRevenue: null,
      variance: null,
      isAnomaly: null,
    });
    expect(inspection.verification.status).toBe(VERIFIED);
  });

  it('includes reconciliation fields when the row has them', () => {
    const inspection = toLogInspection(
      storedLog({
        reportedCash: 950,
        expectedRevenue: 1000,
        variance: -50,
        isAnomaly: true,
      }),
      NOW,
    );

    expect(inspection.log).toMatchObject({
      reportedCash: 950,
      expectedRevenue: 1000,
      variance: -50,
      isAnomaly: true,
    });
  });
});
