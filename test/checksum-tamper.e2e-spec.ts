import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import {
  CORRUPTED_PAYLOAD,
  computePayloadChecksum,
  verifyPayloadChecksum,
} from '../src/kiosk/checksum-validator';
import {
  computeReceiptChecksum,
  signReceiptChecksum,
  verifyReceiptSignature,
  type SignedReceipt,
} from '../src/kiosk/receipt';
import { DUPLICATE_TRANSACTION } from '../src/kiosk/sync-ack';

// ───────────────────────────────────────────────────────────
//  Integration tests for checksum validation and tamper-detection on modified log entries.
//
//  Runs the full AppModule (controller, ValidationPipe, KioskService, checksum validator, receipt signer) over HTTP via supertest. Prisma is replaced by an in-memory fake reset before every test, so the suite needs no database and is deterministic.
// ───────────────────────────────────────────────────────────

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  checksum: string | null;
  isSynced: boolean;
  recordedAt: Date;
  createdAt: Date;
}

const FIXED_NOW = new Date('2026-11-05T00:00:00.000Z');

/** Minimal in-memory implementation of the Prisma calls used by KioskService. */
function createFakePrisma() {
  const kiosks = new Map<string, { id: string; status: string }>();
  const logs: FakeLog[] = [];

  const matchesRecordedAt = (
    log: FakeLog,
    cond?: { gte?: Date; lte?: Date },
  ) => {
    if (!cond) return true;
    const t = log.recordedAt.getTime();
    if (cond.gte && t < cond.gte.getTime()) return false;
    return !(cond.lte && t > cond.lte.getTime());
  };

  return {
    kiosks,
    logs,
    kiosk: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        return kiosks.get(where.id) ?? null;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    dailyLog: {
      // Returns a copy, like a real DB read, so tests can only change
      // stored data through `logs` (the "database").
      findUnique: jest.fn(
        async ({ where }: { where: { transactionId: string } }) => {
          const log = logs.find((l) => l.transactionId === where.transactionId);
          return log ? { ...log } : null;
        },
      ),
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { kioskId: string; recordedAt?: { gte?: Date; lte?: Date } };
          orderBy: { recordedAt: 'asc' | 'desc' };
        }) => {
          const sorted = logs
            .filter((l) => l.kioskId === where.kioskId)
            .filter((l) => matchesRecordedAt(l, where.recordedAt))
            .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
          if (orderBy.recordedAt === 'desc') sorted.reverse();
          return sorted[0] ? { ...sorted[0] } : null;
        },
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<FakeLog, 'id' | 'isSynced' | 'createdAt'>;
        }) => {
          const log: FakeLog = {
            id: `log-${logs.length + 1}`,
            isSynced: true,
            createdAt: FIXED_NOW,
            ...data,
          };
          logs.push(log);
          return { ...log };
        },
      ),
    },
  };
}

const KIOSK_ID = 'KIOSK-PROOF-001';
const LOGS_URL = '/api/kiosk/logs';

interface DailyLogPayload {
  transactionId: string;
  kioskId: string;
  operatorId: string;
  meterVolume: number;
  reportedCash: number;
  recordedAt: string;
  checksum?: string;
}

const ORIGINAL: Omit<DailyLogPayload, 'checksum'> = {
  transactionId: 'TXN-PROOF-001',
  kioskId: KIOSK_ID,
  operatorId: 'OP-007',
  meterVolume: 150.75,
  reportedCash: 2450,
  recordedAt: '2026-11-04T10:00:00.000Z',
};

/** v1 checksum the kiosk computes before sending (Story 14-2 canonical form). */
const v1ChecksumOf = (p: Omit<DailyLogPayload, 'checksum'>) =>
  computePayloadChecksum({
    transactionId: p.transactionId,
    kioskId: p.kioskId,
    meterVolume: p.meterVolume,
    recordedAt: p.recordedAt,
  });

/** Receipt-format checksum, which also covers operatorId and reportedCash. */
const receiptChecksumOf = (p: Omit<DailyLogPayload, 'checksum'>) =>
  computeReceiptChecksum({
    kioskId: p.kioskId,
    operatorId: p.operatorId,
    meterVolume: p.meterVolume,
    reportedCash: p.reportedCash,
    recordedAt: p.recordedAt,
  });

type ReceiptVerdict = 'VALID' | 'CHECKSUM_MISMATCH' | 'BAD_SIGNATURE';

/**
 * Independent verifier for a receipt, as an Operation Manager's
 * checksum-verification badge would do it: recompute the checksum from the
 * receipt's own fields, then check the server signature over that checksum.
 */
function verifyReceipt(receipt: SignedReceipt): ReceiptVerdict {
  const recomputed = computeReceiptChecksum({
    kioskId: receipt.kioskId,
    operatorId: receipt.operatorId,
    meterVolume: receipt.meterVolume,
    reportedCash: receipt.reportedCash,
    recordedAt: receipt.recordedAt,
  });
  if (recomputed !== receipt.checksum) return 'CHECKSUM_MISMATCH';
  if (!verifyReceiptSignature(receipt.checksum, receipt.signature)) {
    return 'BAD_SIGNATURE';
  }
  return 'VALID';
}

/** Flips the last hex character, keeping the string valid hex of the same length. */
const flipLastHexChar = (hex: string) =>
  hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');

describe('Legal volume proving – checksum validation & tamper detection (Story 05, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  beforeEach(async () => {
    prisma = createFakePrisma();
    prisma.kiosks.set(KIOSK_ID, { id: KIOSK_ID, status: 'ONLINE' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    // Same pipe options as main.ts
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const submit = (payload: Partial<DailyLogPayload>) =>
    request(app.getHttpServer()).post(LOGS_URL).send(payload);

  const expectCorruptedPayloadRejection = (res: request.Response) => {
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      ack: false,
      error: CORRUPTED_PAYLOAD,
    });
    expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    expect(prisma.logs).toHaveLength(0);
  };

  // ─────────────────────────────────────────────────────────
  //  Checksum validation – genuine entries are accepted
  // ─────────────────────────────────────────────────────────
  describe('checksum validation of genuine log entries', () => {
    it('accepts an entry with a valid v1 checksum, stores the checksum and returns a valid signed receipt', async () => {
      const checksum = v1ChecksumOf(ORIGINAL);

      const res = await submit({ ...ORIGINAL, checksum }).expect(201);

      expect(res.body).toMatchObject({ ack: true, status: 'SYNCHRONIZED', duplicate: false });
      expect(prisma.logs).toHaveLength(1);
      expect(prisma.logs[0].checksum).toBe(checksum);
      expect(prisma.logs[0].meterVolume).toBe(ORIGINAL.meterVolume);

      const receipt: SignedReceipt = res.body.receipt;
      expect(receipt.checksum).toBe(receiptChecksumOf(ORIGINAL));
      expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyReceipt(receipt)).toBe('VALID');
    });

    it('accepts a v1 checksum with an explicit "v1:" version prefix', async () => {
      await submit({ ...ORIGINAL, checksum: `v1:${v1ChecksumOf(ORIGINAL)}` }).expect(201);
      expect(prisma.logs).toHaveLength(1);
    });

    it('accepts a receipt-format checksum covering operatorId and reportedCash', async () => {
      await submit({ ...ORIGINAL, checksum: receiptChecksumOf(ORIGINAL) }).expect(201);
      expect(prisma.logs).toHaveLength(1);
    });

    it('treats the checksum hex as case-insensitive', async () => {
      await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL).toUpperCase() }).expect(201);
      expect(prisma.logs).toHaveLength(1);
    });

    it('does not flag an equivalent recordedAt representation as tampering', async () => {
      // Checksum computed over "...10:00:00.000Z", sent as "...10:00:00Z" – same instant.
      const checksum = v1ChecksumOf(ORIGINAL);

      await submit({ ...ORIGINAL, recordedAt: '2026-11-04T10:00:00Z', checksum }).expect(201);
      expect(prisma.logs).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  1. In transit – fields modified after the checksum was computed
  // ─────────────────────────────────────────────────────────
  describe('tamper detection: entry modified after the kiosk computed its checksum', () => {
    it.each<[string, Partial<DailyLogPayload>]>([
      ['meterVolume inflated', { meterVolume: 1500.75 }],
      ['meterVolume changed by 0.01 L', { meterVolume: 150.76 }],
      ['meterVolume lowered', { meterVolume: 100 }],
      ['kioskId swapped', { kioskId: 'KIOSK-PROOF-002' }],
      ['recordedAt shifted by 1 second', { recordedAt: '2026-11-04T10:00:01.000Z' }],
      ['recordedAt moved to another day', { recordedAt: '2026-11-03T10:00:00.000Z' }],
      ['transactionId replaced', { transactionId: 'TXN-PROOF-999' }],
    ])('rejects a v1-checksummed entry with %s (422 CORRUPTED_PAYLOAD, nothing stored)', async (_label, change) => {
      const checksum = v1ChecksumOf(ORIGINAL);

      const res = await submit({ ...ORIGINAL, ...change, checksum });

      expectCorruptedPayloadRejection(res);
    });

    it.each<[string, Partial<DailyLogPayload>]>([
      ['reportedCash changed', { reportedCash: 245 }],
      ['reportedCash set to zero', { reportedCash: 0 }],
      ['operatorId swapped', { operatorId: 'OP-099' }],
      ['meterVolume inflated', { meterVolume: 1500.75 }],
    ])('rejects a receipt-checksummed entry with %s (422 CORRUPTED_PAYLOAD, nothing stored)', async (_label, change) => {
      const checksum = receiptChecksumOf(ORIGINAL);

      const res = await submit({ ...ORIGINAL, ...change, checksum });

      expectCorruptedPayloadRejection(res);
    });

    // KNOWN GAP: the v1 checksum covers kioskId, meterVolume, recordedAt and
    // transactionId only, so changing reportedCash on a v1-checksummed entry
    // is not detected and the entry is accepted (201).
    it.failing('rejects a v1-checksummed entry whose reportedCash was changed', async () => {
      const checksum = v1ChecksumOf(ORIGINAL);

      const res = await submit({ ...ORIGINAL, reportedCash: 1, checksum });

      expect(res.status).toBe(422);
    });
  });

  describe('tamper detection: checksum value itself modified', () => {
    it.each<[string, string]>([
      ['one hex character flipped', flipLastHexChar(v1ChecksumOf(ORIGINAL))],
      ['truncated', v1ChecksumOf(ORIGINAL).slice(0, 32)],
      ['wrong version prefix ("legacy:" on a v1 hash)', `legacy:${v1ChecksumOf(ORIGINAL)}`],
      ['checksum of a different entry', v1ChecksumOf({ ...ORIGINAL, meterVolume: 1 })],
      ['non-hex garbage', 'not-a-real-checksum'],
      ['empty string', ''],
    ])('rejects an entry whose checksum is %s', async (_label, checksum) => {
      const res = await submit({ ...ORIGINAL, checksum });

      expectCorruptedPayloadRejection(res);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  2. In storage – stored daily_logs row edited in the database
  // ─────────────────────────────────────────────────────────
  describe('tamper detection: stored log entry modified in the database', () => {
    const storeOriginal = async () => {
      const res = await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL) }).expect(201);
      return { row: prisma.logs[0], receipt: res.body.receipt as SignedReceipt };
    };

    const rowVerifies = (row: FakeLog) =>
      verifyPayloadChecksum(
        {
          transactionId: row.transactionId,
          kioskId: row.kioskId,
          meterVolume: row.meterVolume,
          recordedAt: row.recordedAt,
        },
        row.checksum ?? '',
      );

    it('an untouched stored row still matches its stored checksum', async () => {
      const { row } = await storeOriginal();

      expect(rowVerifies(row)).toBe(true);
    });

    it.each<[string, (row: FakeLog) => void]>([
      ['meterVolume edited', (row) => (row.meterVolume = 999.99)],
      ['recordedAt edited', (row) => (row.recordedAt = new Date('2026-11-04T09:00:00.000Z'))],
      ['kioskId edited', (row) => (row.kioskId = 'KIOSK-PROOF-002')],
      ['stored checksum overwritten', (row) => (row.checksum = flipLastHexChar(row.checksum ?? ''))],
    ])('detects a stored row with %s via checksum recomputation', async (_label, tamper) => {
      const { row } = await storeOriginal();

      tamper(row);

      expect(rowVerifies(row)).toBe(false);
    });

    it('re-acknowledges an untouched stored entry with the same receipt checksum and signature', async () => {
      const { receipt } = await storeOriginal();

      const retry = await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL) }).expect(200);

      expect(retry.body).toMatchObject({ ack: true, duplicate: true });
      expect(retry.body.receipt.checksum).toBe(receipt.checksum);
      expect(retry.body.receipt.signature).toBe(receipt.signature);
      expect(prisma.logs).toHaveLength(1);
    });

    it('refuses to re-acknowledge (409) when the stored meterVolume was edited after submission', async () => {
      const { row } = await storeOriginal();
      row.meterVolume = 999.99;

      const retry = await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL) });

      expect(retry.status).toBe(409);
      expect(retry.body).toMatchObject({ ack: false, error: DUPLICATE_TRANSACTION });
      expect(prisma.logs).toHaveLength(1);
    });

    it('refuses to re-acknowledge (409) when the stored recordedAt was edited after submission', async () => {
      const { row } = await storeOriginal();
      row.recordedAt = new Date('2026-11-04T09:00:00.000Z');

      const retry = await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL) });

      expect(retry.status).toBe(409);
      expect(retry.body).toMatchObject({ ack: false, error: DUPLICATE_TRANSACTION });
    });

    it('the original receipt no longer matches a stored row whose meterVolume was edited', async () => {
      const { row, receipt } = await storeOriginal();
      row.meterVolume = 999.99;

      const checksumFromRow = computeReceiptChecksum({
        kioskId: row.kioskId,
        operatorId: receipt.operatorId,
        meterVolume: row.meterVolume,
        reportedCash: receipt.reportedCash,
        recordedAt: row.recordedAt,
      });

      expect(checksumFromRow).not.toBe(receipt.checksum);
      expect(verifyReceiptSignature(checksumFromRow, receipt.signature)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  3. On receipt – signed receipt modified after it was issued
  // ─────────────────────────────────────────────────────────
  describe('tamper detection: signed receipt modified after it was issued', () => {
    const issueReceipt = async (): Promise<SignedReceipt> => {
      const res = await submit({ ...ORIGINAL, checksum: v1ChecksumOf(ORIGINAL) }).expect(201);
      return res.body.receipt as SignedReceipt;
    };

    it('an unmodified receipt verifies as VALID', async () => {
      expect(verifyReceipt(await issueReceipt())).toBe('VALID');
    });

    it.each<[string, Partial<SignedReceipt>]>([
      ['meterVolume', { meterVolume: 1500.75 }],
      ['reportedCash', { reportedCash: 245 }],
      ['operatorId', { operatorId: 'OP-099' }],
      ['kioskId', { kioskId: 'KIOSK-PROOF-002' }],
      ['recordedAt', { recordedAt: '2026-11-03T10:00:00.000Z' }],
    ])('detects a receipt with a modified %s (CHECKSUM_MISMATCH)', async (_label, change) => {
      const receipt = await issueReceipt();

      expect(verifyReceipt({ ...receipt, ...change })).toBe('CHECKSUM_MISMATCH');
    });

    it('detects a receipt whose fields and checksum were both rewritten (signature no longer matches)', async () => {
      const receipt = await issueReceipt();
      const forged = { ...receipt, reportedCash: 245 };
      forged.checksum = computeReceiptChecksum(forged);
      forged.hash = forged.checksum;

      expect(verifyReceipt(forged)).toBe('BAD_SIGNATURE');
    });

    it('detects a receipt re-signed with a key other than the server key', async () => {
      const receipt = await issueReceipt();
      const forged = { ...receipt, reportedCash: 245 };
      forged.checksum = computeReceiptChecksum(forged);
      forged.signature = signReceiptChecksum(forged.checksum, 'attacker-guessed-key');

      expect(verifyReceipt(forged)).toBe('BAD_SIGNATURE');
    });

    it.each<[string, (sig: string) => string]>([
      ['one hex character flipped', (sig) => flipLastHexChar(sig)],
      ['truncated', (sig) => sig.slice(0, 32)],
      ['replaced with non-hex text', () => 'forged-signature'],
      ['empty', () => ''],
    ])('detects a receipt whose signature is %s (BAD_SIGNATURE)', async (_label, alter) => {
      const receipt = await issueReceipt();

      expect(verifyReceipt({ ...receipt, signature: alter(receipt.signature) })).toBe('BAD_SIGNATURE');
    });
  });
});
