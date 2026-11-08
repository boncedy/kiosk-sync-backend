import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';
import { STATE_CONFLICT } from './meter-conflict';
import { computePayloadChecksum } from './checksum-validator';

// ───────────────────────────────────────────────────────────
//  Story 14-2 – SCRUM-24 (Owner: Earn)
//  Automated edge-case tests for corrupted JSON payloads and schema conflicts.
//
//  CI-friendly & deterministic:
//  - No database: Prisma is replaced by an in-memory fake, reset before every test.
//  - Fixed timestamps only (no `new Date()` in payloads).
//  - Runs the real controller, ValidationPipe (same options as main.ts),
//    KioskService and meter-conflict logic over HTTP via supertest.
//
//  Tests marked `it.failing` describe behaviour the current code does not meet
//  yet (see the KNOWN GAP comment above each). They pass while the gap exists;
//  once the code is fixed they start failing, as a reminder to switch them to `it`.
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

const FIXED_NOW = new Date('2026-10-18T00:00:00.000Z');

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
    },
    dailyLog: {
      findUnique: jest.fn(
        async ({ where }: { where: { transactionId: string } }) => {
          return logs.find((l) => l.transactionId === where.transactionId) ?? null;
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
          return sorted[0] ?? null;
        },
      ),
      create: jest.fn(async ({ data }: { data: Omit<FakeLog, 'id' | 'isSynced' | 'createdAt'> }) => {
        const log: FakeLog = {
          id: `log-${logs.length + 1}`,
          isSynced: true,
          createdAt: FIXED_NOW,
          ...data,
        };
        logs.push(log);
        return log;
      }),
    },
  };
}

const KIOSK_ID = 'KIOSK-EDGE-001';
const LOGS_URL = '/api/kiosk/logs';

interface KioskTestPayload {
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: string;
  checksum?: string;
  [key: string]: unknown;
}

const validPayload = (
  overrides: Record<string, unknown> = {},
): KioskTestPayload => {
  const base = {
    transactionId: 'TXN-EDGE-001',
    kioskId: KIOSK_ID,
    meterVolume: 42.5,
    recordedAt: '2026-10-17T12:00:00.000Z',
  };
  const merged = { ...base, ...overrides };
  const checksum =
    'checksum' in overrides
      ? (overrides.checksum as string | undefined)
      : computePayloadChecksum({
          transactionId: String(merged.transactionId ?? ''),
          kioskId: String(merged.kioskId ?? ''),
          meterVolume: Number(merged.meterVolume ?? 0),
          recordedAt: String(merged.recordedAt ?? ''),
        });

  return { ...merged, checksum };
};

describe('Payload edge cases – corrupted JSON & schema conflicts (Story 14-2, SCRUM-24)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  beforeEach(async () => {
    prisma = createFakePrisma();
    prisma.kiosks.set(KIOSK_ID, { id: KIOSK_ID, status: 'ONLINE' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [KioskService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: false });
    // Same pipe configuration as src/main.ts
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const postRaw = (body: string, contentType = 'application/json') =>
    request(app.getHttpServer())
      .post(LOGS_URL)
      .set('Content-Type', contentType)
      .send(body);

  const postJson = (body: unknown) =>
    request(app.getHttpServer()).post(LOGS_URL).send(body as object);

  // ───────────────────────────────────────────────────────────
  // 1. Malformed JSON
  // ───────────────────────────────────────────────────────────
  describe('1. Malformed JSON body', () => {
    it.each([
      ['truncated JSON', '{"transactionId":"TXN-1","kioskId":"KIOSK-EDGE-001","meterVol'],
      ['trailing comma', '{"transactionId":"TXN-1",}'],
      ['single-quoted keys/values', "{'transactionId':'TXN-1'}"],
      ['unquoted keys', '{transactionId:"TXN-1"}'],
      ['binary garbage', '\u0000\u0001\u0002garbage'],
      ['NaN literal', '{"meterVolume": NaN}'],
      ['two concatenated objects', '{"a":1}{"b":2}'],
    ])('rejects %s with HTTP 400 and writes nothing', async (_label, body) => {
      const res = await postRaw(body);

      expect(res.status).toBe(400);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
      expect(prisma.logs).toHaveLength(0);
    });

    it.each([
      ['null', 'null'],
      ['a string', '"hello"'],
      ['a number', '42'],
      ['a boolean', 'true'],
    ])('rejects top-level JSON %s with HTTP 400', async (_label, body) => {
      const res = await postRaw(body);

      expect(res.status).toBe(400);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('rejects an empty JSON body with the required-field messages', async () => {
      const res = await postRaw('');

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          'transactionId is required',
          'kioskId is required',
          'meterVolume must be a number',
        ]),
      );
    });

    it('rejects an empty JSON object', async () => {
      const res = await postJson({});
      expect(res.status).toBe(400);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('rejects valid JSON sent with a non-JSON content type', async () => {
      const res = await postRaw(JSON.stringify(validPayload()), 'text/plain');

      expect(res.status).toBe(400);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('rejects a body larger than the JSON size limit with HTTP 413', async () => {
      const res = await postJson(validPayload({ padding: 'x'.repeat(200 * 1024) }));

      expect(res.status).toBe(413);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('rejects a JSON array of payloads with HTTP 400', async () => {
      const res = await postJson([validPayload()]);
      expect(res.status).toBe(400);
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('uses the last value when a key is duplicated in the JSON', async () => {
      const body =
        '{"transactionId":"TXN-DUPKEY","kioskId":"KIOSK-EDGE-001",' +
        '"meterVolume":1,"meterVolume":99,"recordedAt":"2026-10-17T12:00:00.000Z"}';
      const res = await postRaw(body);

      expect(res.status).toBe(201);
      expect(prisma.logs[0].meterVolume).toBe(99);
    });

    it('ignores a __proto__ key injected into the JSON', async () => {
      const body = JSON.stringify(validPayload({ transactionId: 'TXN-PROTO' })).replace(
        '{',
        '{"__proto__":{"meterVolume":-1,"isAdmin":true},',
      );
      const res = await postRaw(body);

      expect(res.status).toBe(201);
      expect(prisma.logs[0].meterVolume).toBe(42.5);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────
  // 2. Schema mismatch (wrong types / shapes)
  // ───────────────────────────────────────────────────────────
  describe('2. Schema mismatch', () => {
    it.each([
      ['a numeric string', '42.5'],
      ['a boolean', true],
      ['null', null],
      ['an object', { value: 42.5 }],
      ['an array', [42.5]],
    ])('rejects meterVolume as %s', async (_label, meterVolume) => {
      const res = await postJson(validPayload({ meterVolume }));

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('meterVolume must be a number');
      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('rejects meterVolume that overflows to Infinity (1e309)', async () => {
      const body = JSON.stringify(validPayload()).replace('42.5', '1e309');
      const res = await postRaw(body);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('meterVolume must be a number');
    });

    it.each([
      ['a number', 12345],
      ['an object', { id: 'TXN-1' }],
      ['an array', ['TXN-1']],
    ])('rejects transactionId as %s', async (_label, transactionId) => {
      const res = await postJson(validPayload({ transactionId }));
      expect(res.status).toBe(400);
    });

    it('rejects kioskId as a number', async () => {
      const res = await postJson(validPayload({ kioskId: 1 }));
      expect(res.status).toBe(400);
    });

    it.each([
      ['an epoch number', 1792240800000],
      ['a non-date string', 'yesterday'],
      ['null', null],
    ])('rejects recordedAt as %s', async (_label, recordedAt) => {
      const res = await postJson(validPayload({ recordedAt }));
      expect(res.status).toBe(400);
    });

    // KNOWN GAP: @IsDateString() checks the format only, so an impossible date such as
    // Feb 30 is accepted and `new Date()` silently rolls it over to Mar 2.
    it.failing('rejects recordedAt as an impossible calendar date (Feb 30)', async () => {
      const res = await postJson(validPayload({ recordedAt: '2026-02-30T12:00:00.000Z' }));
      expect(res.status).toBe(400);
    });

    it.each([
      ['a number', 123],
      ['an object', { sha256: 'abc' }],
    ])('rejects checksum as %s', async (_label, checksum) => {
      const res = await postJson(validPayload({ checksum }));
      expect(res.status).toBe(400);
    });

    it('rejects a snake_case-only payload (legacy client format)', async () => {
      const res = await postJson({
        transaction_id: 'TXN-SNAKE',
        kiosk_id: KIOSK_ID,
        meter_volume: 42.5,
        recorded_at: '2026-10-17T12:00:00.000Z',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('transactionId is required');
    });

    it('accepts the dual camelCase + snake_case body the kiosk client sends, storing only camelCase fields', async () => {
      const res = await postJson({
        ...validPayload({ transactionId: 'TXN-DUAL' }),
        transaction_id: 'TXN-DUAL',
        kiosk_id: KIOSK_ID,
        meter_volume: 999,
        recorded_at: '2026-10-17T12:00:00.000Z',
        checksum_version: 'v1',
      });

      expect(res.status).toBe(201);
      expect(prisma.logs[0].meterVolume).toBe(42.5);
      expect(prisma.logs[0]).not.toHaveProperty('meter_volume');
      expect(prisma.logs[0]).not.toHaveProperty('checksum_version');
    });

    it('strips unknown fields instead of persisting them', async () => {
      const res = await postJson(
        validPayload({ transactionId: 'TXN-EXTRA', isSynced: false, id: 'forged-id' }),
      );

      expect(res.status).toBe(201);
      expect(prisma.logs[0].id).not.toBe('forged-id');
      expect(prisma.logs[0].isSynced).toBe(true);
    });

    // KNOWN GAP: @IsNotEmpty() allows whitespace, so "   " passes validation and
    // only fails later as an unknown kiosk (404) instead of a schema error (400).
    it.failing('rejects a whitespace-only kioskId as a schema error (400)', async () => {
      const res = await postJson(validPayload({ kioskId: '   ' }));
      expect(res.status).toBe(400);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 3. Corrupted payload / checksum
  // ───────────────────────────────────────────────────────────
  describe('3. Corrupted payload & checksum', () => {
    it('rejects a payload whose checksum does not match its fields (HTTP 422)', async () => {
      const res = await postJson(
        validPayload({ transactionId: 'TXN-BAD-HASH', checksum: 'f'.repeat(64) }),
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        ack: false,
        error: 'CORRUPTED_PAYLOAD',
      });
    });

    it('stores the checksum exactly as received', async () => {
      const payload = validPayload({ transactionId: 'TXN-HASH' });
      const checksum = payload.checksum;
      const res = await postJson(payload);

      expect(res.status).toBe(201);
      expect(prisma.logs[0].checksum).toBe(checksum);
    });

    it('stores null when checksum is omitted', async () => {
      const { checksum: _omit, ...noChecksum } = validPayload({ transactionId: 'TXN-NOHASH' });
      const res = await postJson(noChecksum);

      expect(res.status).toBe(201);
      expect(prisma.logs[0].checksum).toBeNull();
    });

    it('accepts a legacy SHA-256 checksum and stores it (HTTP 201)', async () => {
      const payloadWithoutChecksum = {
        transactionId: 'TXN-LEGACY',
        kioskId: KIOSK_ID,
        meterVolume: 42.5,
        recordedAt: '2026-10-17T12:00:00.000Z',
      };
      const legacyChecksum = computePayloadChecksum(payloadWithoutChecksum, 'legacy');
      const res = await postJson({
        ...payloadWithoutChecksum,
        checksum: legacyChecksum,
      });

      expect(res.status).toBe(201);
      expect(prisma.logs[0].checksum).toBe(legacyChecksum);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 4. Conflicts with server state
  // ───────────────────────────────────────────────────────────
  describe('4. Conflicts with server state', () => {
    const seed = async (transactionId: string, meterVolume: number, recordedAt: string) => {
      const res = await postJson(validPayload({ transactionId, meterVolume, recordedAt }));
      expect(res.status).toBe(201);
    };

    it('confirms a new record with a SYNCHRONIZED ACK (HTTP 201)', async () => {
      const res = await postJson(validPayload({ transactionId: 'TXN-ACK' }));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: false,
        transactionId: 'TXN-ACK',
        logId: prisma.logs[0].id,
      });
    });

    it('re-acknowledges an identical retry of a stored transactionId with 200 and writes nothing', async () => {
      await seed('TXN-DUP', 10, '2026-10-17T10:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-DUP', meterVolume: 10, recordedAt: '2026-10-17T10:00:00.000Z' }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: true,
        transactionId: 'TXN-DUP',
        logId: prisma.logs[0].id,
      });
      expect(prisma.logs).toHaveLength(1);
    });

    it('rejects a stored transactionId sent with a different reading (409 DUPLICATE_TRANSACTION, not a STATE_CONFLICT)', async () => {
      await seed('TXN-DUP', 10, '2026-10-17T10:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-DUP', meterVolume: 11, recordedAt: '2026-10-17T10:00:00.000Z' }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ack: false, error: 'DUPLICATE_TRANSACTION' });
      expect(res.body.error).not.toBe(STATE_CONFLICT);
      expect(res.body.message).toContain('already exists');
      expect(prisma.logs).toHaveLength(1);
      expect(prisma.logs[0].meterVolume).toBe(10);
    });

    it('rejects a reading lower than an older server reading (LOWER_THAN_OLDER_READING)', async () => {
      await seed('TXN-OLD', 100, '2026-10-17T10:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-LOWER', meterVolume: 50, recordedAt: '2026-10-17T11:00:00.000Z' }),
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        ack: false,
        error: STATE_CONFLICT,
        reason: 'LOWER_THAN_OLDER_READING',
        conflictingRecord: { transactionId: 'TXN-OLD', meterVolume: 100 },
      });
      expect(prisma.logs).toHaveLength(1);
    });

    it('rejects an offline reading higher than a newer server reading (HIGHER_THAN_NEWER_READING)', async () => {
      await seed('TXN-NEW', 100, '2026-10-17T12:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-HIGHER', meterVolume: 150, recordedAt: '2026-10-17T11:00:00.000Z' }),
      );

      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('HIGHER_THAN_NEWER_READING');
      expect(res.body.conflictingRecord.transactionId).toBe('TXN-NEW');
    });

    it('rejects a different volume at the exact same recordedAt', async () => {
      await seed('TXN-SAME-1', 100, '2026-10-17T12:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-SAME-2', meterVolume: 101, recordedAt: '2026-10-17T12:00:00.000Z' }),
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STATE_CONFLICT);
    });

    it('treats the same instant in a different timezone offset as the same recordedAt', async () => {
      await seed('TXN-TZ-1', 100, '2026-10-17T12:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-TZ-2', meterVolume: 101, recordedAt: '2026-10-17T19:00:00+07:00' }),
      );

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STATE_CONFLICT);
    });

    it('accepts an offline reading that fits between existing readings', async () => {
      await seed('TXN-A', 100, '2026-10-17T10:00:00.000Z');
      await seed('TXN-C', 300, '2026-10-17T12:00:00.000Z');
      const res = await postJson(
        validPayload({ transactionId: 'TXN-B', meterVolume: 200, recordedAt: '2026-10-17T11:00:00.000Z' }),
      );

      expect(res.status).toBe(201);
      expect(prisma.logs.map((l) => l.transactionId)).toEqual(['TXN-A', 'TXN-C', 'TXN-B']);
    });

    it('does not compare readings across different kiosks', async () => {
      prisma.kiosks.set('KIOSK-OTHER', { id: 'KIOSK-OTHER', status: 'ONLINE' });
      await seed('TXN-K1', 500, '2026-10-17T10:00:00.000Z');
      const res = await postJson(
        validPayload({
          transactionId: 'TXN-K2',
          kioskId: 'KIOSK-OTHER',
          meterVolume: 1,
          recordedAt: '2026-10-17T11:00:00.000Z',
        }),
      );

      expect(res.status).toBe(201);
    });

    it('rejects a reading for an unknown kiosk with 404 before any conflict check', async () => {
      const res = await postJson(validPayload({ kioskId: 'KIOSK-UNKNOWN' }));

      expect(res.status).toBe(404);
      expect(prisma.dailyLog.findFirst).not.toHaveBeenCalled();
      expect(prisma.logs).toHaveLength(0);
    });
  });
});
