import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { computePayloadChecksum } from '../src/kiosk/checksum-validator';
import {
  CHECKSUM_MISMATCH,
  NO_CHECKSUM,
  VERIFIED,
} from '../src/kiosk/log-inspection';

// ───────────────────────────────────────────────────────────
//  Story 05 – Read-only historical log inspection for Operation Managers.
//
//  Runs the full AppModule over HTTP. Prisma is an in-memory fake, so a test
//  can edit a stored row directly (as a DB user could) and check that the
//  inspection endpoint reports the change.
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
          data: Omit<FakeLog, 'id' | 'isSynced' | 'createdAt'>;
        }) => {
          const log: FakeLog = {
            id: `log-${String(logs.length + 1).padStart(3, '0')}`,
            isSynced: true,
            createdAt: new Date('2026-11-06T00:00:00.000Z'),
            ...data,
          };
          logs.push(log);
          return { ...log };
        },
      ),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

const KIOSK_ID = 'KIOSK-HIST-001';

const READING = {
  transactionId: 'TXN-HIST-001',
  kioskId: KIOSK_ID,
  operatorId: 'OP-007',
  meterVolume: 150.75,
  reportedCash: 2450,
  recordedAt: '2026-11-04T10:00:00.000Z',
};

const v1ChecksumOf = (r: typeof READING) =>
  computePayloadChecksum({
    transactionId: r.transactionId,
    kioskId: r.kioskId,
    meterVolume: r.meterVolume,
    recordedAt: r.recordedAt,
  });

describe('Historical log inspection (Story 05, e2e)', () => {
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const submit = async (reading: typeof READING, checksum?: string) => {
    const res = await http()
      .post('/api/kiosk/logs')
      .send({ ...reading, checksum })
      .expect(201);
    return res.body.logId as string;
  };

  const inspect = (logId: string) =>
    http().get(`/api/kiosk/logs/${logId}/inspect`);

  const expectNoWrites = () => {
    for (const write of [
      'create',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ] as const) {
      expect(prisma.dailyLog[write]).not.toHaveBeenCalled();
    }
  };

  describe('GET /api/kiosk/logs/:id/inspect', () => {
    it('shows an untouched submission as verified, with its stored details', async () => {
      const checksum = v1ChecksumOf(READING);
      const logId = await submit(READING, checksum);

      const res = await inspect(logId).expect(200);

      expect(res.body.log).toMatchObject({
        id: logId,
        transactionId: READING.transactionId,
        kioskId: KIOSK_ID,
        meterVolume: READING.meterVolume,
        recordedAt: READING.recordedAt,
      });
      expect(res.body.verification).toMatchObject({
        status: VERIFIED,
        algorithm: 'SHA-256',
        format: 'v1',
        storedChecksum: checksum,
        recomputedChecksum: checksum,
      });
      expect(Date.parse(res.body.verification.verifiedAt)).not.toBeNaN();
    });

    it.each<[string, (row: FakeLog) => void]>([
      ['meterVolume', (row) => (row.meterVolume = 1500.75)],
      [
        'recordedAt',
        (row) => (row.recordedAt = new Date('2026-11-03T10:00:00.000Z')),
      ],
      [
        'checksum',
        (row) => (row.checksum = v1ChecksumOf({ ...READING, meterVolume: 1 })),
      ],
    ])(
      'flags a checksum mismatch after %s is edited directly in the database',
      async (_field, tamper) => {
        const checksum = v1ChecksumOf(READING);
        const logId = await submit(READING, checksum);
        await inspect(logId).expect(200);

        tamper(prisma.logs[0]);
        const res = await inspect(logId).expect(200);

        expect(res.body.verification.status).toBe(CHECKSUM_MISMATCH);
        expect(res.body.verification.recomputedChecksum).not.toBe(
          res.body.verification.storedChecksum,
        );
      },
    );

    it('does not write to the database', async () => {
      prisma.logs.push({
        id: 'log-seeded',
        ...READING,
        recordedAt: new Date(READING.recordedAt),
        createdAt: new Date(READING.recordedAt),
        checksum: v1ChecksumOf(READING),
        isSynced: true,
      });

      await inspect('log-seeded').expect(200);
      await http().get('/api/kiosk/logs').expect(200);

      expectNoWrites();
    });

    it('reports a log stored without a checksum as not verifiable', async () => {
      const logId = await submit(READING);

      const res = await inspect(logId).expect(200);

      expect(res.body.verification).toMatchObject({
        status: NO_CHECKSUM,
        storedChecksum: null,
        recomputedChecksum: null,
      });
    });

    it('answers 404 for an unknown log', async () => {
      const res = await inspect('missing-log').expect(404);

      expect(res.body.message).toBe('Log "missing-log" not found.');
    });
  });

  describe('GET /api/kiosk/logs', () => {
    /** Seeds `count` logs, one hour apart, for the given kiosk. */
    const seed = (count: number, kioskId = KIOSK_ID) => {
      for (let i = 0; i < count; i++) {
        prisma.logs.push({
          id: `${kioskId}-log-${i}`,
          transactionId: `${kioskId}-TXN-${i}`,
          kioskId,
          meterVolume: 100 + i,
          checksum: null,
          isSynced: true,
          recordedAt: new Date(Date.UTC(2026, 10, 1, i)),
          createdAt: new Date(Date.UTC(2026, 10, 1, i)),
        });
      }
    };

    it('returns logs newest first with summary fields only', async () => {
      seed(3);

      const res = await http().get('/api/kiosk/logs').expect(200);

      expect(res.body.data.map((l: FakeLog) => l.transactionId)).toEqual([
        `${KIOSK_ID}-TXN-2`,
        `${KIOSK_ID}-TXN-1`,
        `${KIOSK_ID}-TXN-0`,
      ]);
      expect(Object.keys(res.body.data[0]).sort()).toEqual([
        'createdAt',
        'id',
        'kioskId',
        'meterVolume',
        'recordedAt',
        'transactionId',
      ]);
      expect(res.body.nextCursor).toBeNull();
    });

    it('pages through every log with limit and nextCursor', async () => {
      seed(5);
      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const res: request.Response = await http()
          .get('/api/kiosk/logs')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...res.body.data.map((l: FakeLog) => l.id));
        cursor = res.body.nextCursor;
      } while (cursor);

      expect(seen).toEqual([4, 3, 2, 1, 0].map((i) => `${KIOSK_ID}-log-${i}`));
    });

    it('filters by kioskId', async () => {
      seed(2);
      seed(2, 'KIOSK-OTHER');

      const res = await http()
        .get('/api/kiosk/logs')
        .query({ kioskId: 'KIOSK-OTHER' })
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(
        res.body.data.every((l: FakeLog) => l.kioskId === 'KIOSK-OTHER'),
      ).toBe(true);
    });

    it.each(['0', '101', '2.5', 'abc'])(
      'rejects limit=%s with 400',
      async (limit) => {
        await http().get('/api/kiosk/logs').query({ limit }).expect(400);
      },
    );
  });
});
