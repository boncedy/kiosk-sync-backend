import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { computePayloadChecksum } from '../src/kiosk/checksum-validator';
import {
  computeReceiptChecksum,
  verifyReceiptSignature,
  type SignedReceipt,
} from '../src/kiosk/receipt';
import { CHECKSUM_MISMATCH, VERIFIED } from '../src/kiosk/log-inspection';

// ───────────────────────────────────────────────────────────
//  Story 05 – Implement legal volume proving (Owner: Earn)
//  Submission → storage → inspection hash round trip.
// ───────────────────────────────────────────────────────────

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId: string | null;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  proofImageUrl: string | null;
  waterType: 'COMMERCIAL' | 'SUBSIDIZED';
  checksum: string | null;
  isSynced: boolean;
  isReadByManager: boolean;
  recordedAt: Date;
  createdAt: Date;
}

type RecordedAtFilter = { gte?: Date; lte?: Date };

const byNewest = (a: FakeLog, b: FakeLog) =>
  b.recordedAt.getTime() - a.recordedAt.getTime() || b.id.localeCompare(a.id);

/** In-memory stand-in for the Prisma calls used by the kiosk module. */
function createFakePrisma() {
  const kiosks = new Map<string, { id: string; status: string }>();
  const logs: FakeLog[] = [];

  const inRange = (log: FakeLog, range?: RecordedAtFilter) =>
    (!range?.gte || log.recordedAt >= range.gte) &&
    (!range?.lte || log.recordedAt <= range.lte);

  const pick = (log: FakeLog, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select).map((k) => [k, log[k as keyof FakeLog]]),
        )
      : { ...log };

  return {
    kiosks,
    logs,
    kiosk: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          kiosks.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    dailyLog: {
      // Reads return copies, like a real DB, so stored data only changes
      // through `logs` (the simulated direct DB access).
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; transactionId?: string };
        }) => {
          const log = logs.find((l) =>
            where.id !== undefined
              ? l.id === where.id
              : l.transactionId === where.transactionId,
          );
          return log ? { ...log } : null;
        },
      ),
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { kioskId: string; recordedAt?: RecordedAtFilter };
          orderBy: { recordedAt: 'asc' | 'desc' };
        }) => {
          const matches = logs
            .filter(
              (l) =>
                l.kioskId === where.kioskId && inRange(l, where.recordedAt),
            )
            .sort(byNewest);
          if (orderBy.recordedAt === 'asc') matches.reverse();
          return matches[0] ? { ...matches[0] } : null;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          take,
          skip = 0,
          cursor,
          select,
        }: {
          where?: { kioskId?: string };
          take: number;
          skip?: number;
          cursor?: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const sorted = logs
            .filter((l) => !where?.kioskId || l.kioskId === where.kioskId)
            .sort(byNewest);
          const start = cursor
            ? sorted.findIndex((l) => l.id === cursor.id)
            : 0;
          if (start < 0) return [];
          return sorted
            .slice(start + skip, start + skip + take)
            .map((l) => pick(l, select));
        },
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<FakeLog, 'id' | 'isSynced' | 'isReadByManager' | 'createdAt'>;
        }) => {
          const log: FakeLog = {
            id: `log-${String(logs.length + 1).padStart(3, '0')}`,
            isSynced: true,
            isReadByManager: false,
            createdAt: new Date('2026-11-06T00:00:00.000Z'),
            ...data,
          };
          logs.push(log);
          return { ...log };
        },
      ),
    },
  };
}

const KIOSK_ID = 'KIOSK-HASH-001';

interface Submission {
  transactionId: string;
  kioskId: string;
  operatorId?: string;
  meterVolume: number;
  reportedCash?: number;
  recordedAt: string;
}

const SUBMISSION: Submission = {
  transactionId: 'TXN-HASH-001',
  kioskId: KIOSK_ID,
  operatorId: 'OP-007',
  meterVolume: 150.75,
  reportedCash: 2450,
  recordedAt: '2026-11-04T10:00:00.000Z',
};

/** Hashes a kiosk can compute before sending (see `checksum-validator.ts`). */
const v1Hash = (s: Submission) =>
  computePayloadChecksum({
    transactionId: s.transactionId,
    kioskId: s.kioskId,
    meterVolume: s.meterVolume,
    recordedAt: s.recordedAt,
  });

const legacyHash = (s: Submission) =>
  computePayloadChecksum(
    {
      transactionId: s.transactionId,
      kioskId: s.kioskId,
      meterVolume: s.meterVolume,
      recordedAt: s.recordedAt,
    },
    'legacy',
  );

const receiptHash = (s: Submission) =>
  computeReceiptChecksum({
    kioskId: s.kioskId,
    operatorId: s.operatorId,
    meterVolume: s.meterVolume,
    reportedCash: s.reportedCash,
    recordedAt: s.recordedAt,
  });

/** Receipt-format hash of a stored row's current values. */
const receiptHashOfRow = (row: FakeLog) =>
  computeReceiptChecksum({
    kioskId: row.kioskId,
    operatorId: row.operatorId,
    meterVolume: row.meterVolume,
    reportedCash: row.reportedCash,
    recordedAt: row.recordedAt,
  });

/** v1 hash of a stored row's current values. */
const v1HashOfRow = (row: FakeLog) =>
  computePayloadChecksum({
    transactionId: row.transactionId,
    kioskId: row.kioskId,
    meterVolume: row.meterVolume,
    recordedAt: row.recordedAt,
  });

describe('Hash round trip: submission → storage → inspection (Story 05, e2e)', () => {
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** Submits a reading and returns the stored row's id and the signed receipt. */
  const submit = async (submission: Submission, checksum?: string) => {
    const res = await http()
      .post('/api/kiosk/logs')
      .send({ ...submission, checksum })
      .expect(201);
    return {
      logId: res.body.logId as string,
      receipt: res.body.receipt as SignedReceipt,
    };
  };

  const inspect = async (logId: string) => {
    const res = await http().get(`/api/kiosk/logs/${logId}/inspect`).expect(200);
    return res.body.verification as {
      status: string;
      format: string | null;
      storedChecksum: string | null;
      recomputedChecksum: string | null;
    };
  };

  const rowOf = (logId: string) => {
    const row = prisma.logs.find((l) => l.id === logId);
    if (!row) throw new Error(`no stored row ${logId}`);
    return row;
  };

  // ─────────────────────────────────────────────────────────
  //  1. Valid submissions generate matching hashes
  // ─────────────────────────────────────────────────────────
  describe('valid submissions generate matching hashes', () => {
    it.each<[string, string, string, string]>([
      ['v1 (unprefixed)', v1Hash(SUBMISSION), 'v1', v1Hash(SUBMISSION)],
      ['v1 ("v1:" prefix)', `v1:${v1Hash(SUBMISSION)}`, 'v1', v1Hash(SUBMISSION)],
      ['v1 (uppercase hex)', v1Hash(SUBMISSION).toUpperCase(), 'v1', v1Hash(SUBMISSION)],
      ['legacy (unprefixed)', legacyHash(SUBMISSION), 'legacy', legacyHash(SUBMISSION)],
      ['legacy ("legacy:" prefix)', `legacy:${legacyHash(SUBMISSION)}`, 'legacy', legacyHash(SUBMISSION)],
      ['receipt format', receiptHash(SUBMISSION), 'receipt', receiptHash(SUBMISSION)],
    ])(
      'a %s checksum is stored as sent and verified on inspection',
      async (_label, sent, expectedFormat, expectedHash) => {
        const { logId } = await submit(SUBMISSION, sent);

        expect(rowOf(logId).checksum).toBe(sent);

        const verification = await inspect(logId);
        expect(verification).toMatchObject({
          status: VERIFIED,
          format: expectedFormat,
          storedChecksum: sent,
          recomputedChecksum: expectedHash,
        });
      },
    );

    it('the signed receipt hash matches the stored row and its signature is valid', async () => {
      const { logId, receipt } = await submit(SUBMISSION, v1Hash(SUBMISSION));

      expect(receipt.checksum).toBe(receiptHash(SUBMISSION));
      expect(receipt.checksum).toBe(receiptHashOfRow(rowOf(logId)));
      expect(verifyReceiptSignature(receipt.checksum, receipt.signature)).toBe(true);
    });

    it('produces the same recomputed hash on every inspection (deterministic)', async () => {
      const { logId } = await submit(SUBMISSION, v1Hash(SUBMISSION));

      const first = await inspect(logId);
      const second = await inspect(logId);

      expect(second.recomputedChecksum).toBe(first.recomputedChecksum);
      expect(second.status).toBe(VERIFIED);
    });

    it('verifies a v1 checksum computed over an equivalent recordedAt string', async () => {
      // Hash over "...10:00:00.000Z", reading sent as "...10:00:00Z": same instant.
      const { logId } = await submit(
        { ...SUBMISSION, recordedAt: '2026-11-04T10:00:00Z' },
        v1Hash(SUBMISSION),
      );

      expect((await inspect(logId)).status).toBe(VERIFIED);
    });

    it('every submission in a day verifies, each with its own distinct hash', async () => {
      const readings = [100, 125.5, 150.75, 180].map((meterVolume, i) => ({
        ...SUBMISSION,
        transactionId: `TXN-HASH-DAY-${i}`,
        meterVolume,
        recordedAt: `2026-11-04T0${i + 6}:00:00.000Z`,
      }));

      const hashes = new Set<string>();
      for (const reading of readings) {
        const { logId } = await submit(reading, v1Hash(reading));
        const verification = await inspect(logId);

        expect(verification.status).toBe(VERIFIED);
        expect(verification.recomputedChecksum).toBe(v1Hash(reading));
        hashes.add(verification.recomputedChecksum ?? '');
      }

      expect(hashes.size).toBe(readings.length);
    });

    // KNOWN GAP: a receipt-format checksum sent without reportedCash hashes it
    // as "" at submission, but the row stores reportedCash = 0, so inspection
    // recomputes with "0" and flags a genuine log as CHECKSUM_MISMATCH.
    it.failing('verifies a genuine receipt-format log submitted without reportedCash', async () => {
      const withoutCash: Submission = { ...SUBMISSION, reportedCash: undefined };
      const { logId } = await submit(withoutCash, receiptHash(withoutCash));

      expect((await inspect(logId)).status).toBe(VERIFIED);
    });

    // KNOWN GAP: the receipt format hashes recordedAt as the string the kiosk
    // sent, but inspection rebuilds it from the stored Date (".000Z" form), so
    // a genuine log sent without milliseconds is flagged as CHECKSUM_MISMATCH.
    it.failing('verifies a genuine receipt-format log whose recordedAt was sent without milliseconds', async () => {
      const noMillis: Submission = { ...SUBMISSION, recordedAt: '2026-11-04T10:00:00Z' };
      const { logId } = await submit(noMillis, receiptHash(noMillis));

      expect((await inspect(logId)).status).toBe(VERIFIED);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  2. Simulated direct DB mutations trigger a verification failure
  // ─────────────────────────────────────────────────────────
  describe('simulated direct DB mutations trigger a verification failure on inspection', () => {
    it.each<[string, (row: FakeLog) => void]>([
      ['meterVolume changed by 0.01 L', (row) => (row.meterVolume += 0.01)],
      ['meterVolume set to 0', (row) => (row.meterVolume = 0)],
      ['recordedAt moved by 1 ms', (row) => (row.recordedAt = new Date(row.recordedAt.getTime() + 1))],
      ['kioskId reassigned', (row) => (row.kioskId = 'KIOSK-HASH-002')],
      ['transactionId replaced', (row) => (row.transactionId = 'TXN-HASH-999')],
    ])(
      'v1-checksummed row with %s is reported as CHECKSUM_MISMATCH',
      async (_label, mutate) => {
        const { logId } = await submit(SUBMISSION, v1Hash(SUBMISSION));
        expect((await inspect(logId)).status).toBe(VERIFIED);

        const row = rowOf(logId);
        mutate(row);
        const verification = await inspect(logId);

        expect(verification).toMatchObject({
          status: CHECKSUM_MISMATCH,
          format: 'v1',
          storedChecksum: v1Hash(SUBMISSION),
          // Recomputed from the edited DB values, not cached from submission
          recomputedChecksum: v1HashOfRow(row),
        });
        expect(verification.recomputedChecksum).not.toBe(verification.storedChecksum);
      },
    );

    it.each<[string, (row: FakeLog) => void]>([
      ['reportedCash lowered', (row) => (row.reportedCash = 245)],
      ['reportedCash set to 0', (row) => (row.reportedCash = 0)],
      ['operatorId reassigned', (row) => (row.operatorId = 'OP-099')],
      ['operatorId cleared', (row) => (row.operatorId = null)],
      ['meterVolume inflated', (row) => (row.meterVolume = 1500.75)],
    ])(
      'receipt-checksummed row with %s is reported as CHECKSUM_MISMATCH',
      async (_label, mutate) => {
        const { logId } = await submit(SUBMISSION, receiptHash(SUBMISSION));
        expect((await inspect(logId)).status).toBe(VERIFIED);

        mutate(rowOf(logId));

        expect((await inspect(logId)).status).toBe(CHECKSUM_MISMATCH);
      },
    );

    it('a row pinned with a "v1:" prefix is still checked as v1 after a mutation', async () => {
      const { logId } = await submit(SUBMISSION, `v1:${v1Hash(SUBMISSION)}`);

      rowOf(logId).meterVolume = 1500.75;

      expect(await inspect(logId)).toMatchObject({
        status: CHECKSUM_MISMATCH,
        format: 'v1',
      });
    });

    it('verification is live: a reverted mutation verifies again', async () => {
      const { logId } = await submit(SUBMISSION, v1Hash(SUBMISSION));
      const row = rowOf(logId);

      row.meterVolume = 1500.75;
      expect((await inspect(logId)).status).toBe(CHECKSUM_MISMATCH);

      row.meterVolume = SUBMISSION.meterVolume;
      expect((await inspect(logId)).status).toBe(VERIFIED);
    });

    it('only the mutated row fails when inspecting every log in the history', async () => {
      const readings = [100, 125.5, 150.75].map((meterVolume, i) => ({
        ...SUBMISSION,
        transactionId: `TXN-HASH-SWEEP-${i}`,
        meterVolume,
        recordedAt: `2026-11-04T0${i + 6}:00:00.000Z`,
      }));
      for (const reading of readings) await submit(reading, v1Hash(reading));

      prisma.logs.find((l) => l.transactionId === 'TXN-HASH-SWEEP-1')!.meterVolume = 999;

      const list = await http().get('/api/kiosk/logs').expect(200);
      const results: Record<string, string> = {};
      for (const log of list.body.data as { id: string; transactionId: string }[]) {
        results[log.transactionId] = (await inspect(log.id)).status;
      }

      expect(results).toEqual({
        'TXN-HASH-SWEEP-0': VERIFIED,
        'TXN-HASH-SWEEP-1': CHECKSUM_MISMATCH,
        'TXN-HASH-SWEEP-2': VERIFIED,
      });
    });

    it('a row whose values and checksum were both rewritten no longer matches the signed receipt', async () => {
      const { logId, receipt } = await submit(SUBMISSION, v1Hash(SUBMISSION));
      const row = rowOf(logId);

      row.meterVolume = 1500.75;
      row.checksum = v1HashOfRow(row);

      expect(receiptHashOfRow(row)).not.toBe(receipt.checksum);
      expect(verifyReceiptSignature(receiptHashOfRow(row), receipt.signature)).toBe(false);
    });

    // KNOWN GAP: the stored checksum is not signed, so someone with DB access
    // who rewrites a value and recomputes a matching checksum passes inspection.
    // Only the operator's signed receipt (test above) still exposes the change.
    it.failing('flags a row whose values and checksum were both rewritten consistently', async () => {
      const { logId } = await submit(SUBMISSION, v1Hash(SUBMISSION));
      const row = rowOf(logId);

      row.meterVolume = 1500.75;
      row.checksum = v1HashOfRow(row);

      expect((await inspect(logId)).status).toBe(CHECKSUM_MISMATCH);
    });

    // KNOWN GAP: the v1 checksum does not cover reportedCash, so editing the
    // cash on a v1-checksummed row is not detected on inspection.
    it.failing('flags a v1-checksummed row whose reportedCash was edited', async () => {
      const { logId } = await submit(SUBMISSION, v1Hash(SUBMISSION));

      rowOf(logId).reportedCash = 245;

      expect((await inspect(logId)).status).toBe(CHECKSUM_MISMATCH);
    });
  });
});
