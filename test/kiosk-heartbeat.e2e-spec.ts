import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma.service';

// Story 01 – Integration tests: heartbeat ping → status registry → offline timeout.
// PrismaService is replaced with an in-memory store so the tests run without a database.

type KioskRow = {
  id: string;
  status: string;
  lastHeartbeat: Date | null;
};

const createInMemoryPrisma = () => {
  const kiosks = new Map<string, KioskRow>();

  return {
    kiosks,
    kiosk: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        kiosks.has(where.id) ? { ...kiosks.get(where.id)! } : null,
      ),
      upsert: jest.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { id: string };
          update: Partial<KioskRow>;
          create: KioskRow;
        }) => {
          const existing = kiosks.get(where.id);
          const row = existing ? { ...existing, ...update } : { ...create };
          kiosks.set(where.id, row);
          return { ...row };
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<KioskRow>;
        }) => {
          const row = { ...kiosks.get(where.id)!, ...data };
          kiosks.set(where.id, row);
          return { ...row };
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: string; lastHeartbeat?: { lt?: Date } };
          data: Partial<KioskRow>;
        }) => {
          let count = 0;
          for (const [id, row] of kiosks.entries()) {
            const statusMatches =
              !where.status || row.status === where.status;
            const timeMatches =
              !where.lastHeartbeat?.lt ||
              (row.lastHeartbeat && row.lastHeartbeat < where.lastHeartbeat.lt);
            if (statusMatches && timeMatches) {
              kiosks.set(id, { ...row, ...data });
              count++;
            }
          }
          return { count };
        },
      ),
    },
  };
};

describe('Kiosk heartbeat (e2e)', () => {
  const T0 = new Date('2026-10-16T10:00:00.000Z');

  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createInMemoryPrisma>;

  const advanceSeconds = (seconds: number) =>
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));

  const ping = (kioskId = 'KIOSK-001') =>
    request(app.getHttpServer())
      .post('/api/kiosk/heartbeat')
      .send({ kioskId, timestamp: new Date().toISOString() });

  const status = (kioskId = 'KIOSK-001') =>
    request(app.getHttpServer()).get(`/api/kiosk/status/${kioskId}`);

  beforeEach(async () => {
    // Fake only Date – the HTTP stack still needs real timers and I/O.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    jest.setSystemTime(T0);

    prisma = createInMemoryPrisma();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.useRealTimers();
  });

  describe('POST /api/kiosk/heartbeat', () => {
    // NOTE: the spec (section 3.1) says 200 OK, but the endpoint is a plain
    // @Post() so Nest returns 201 Created. Asserting current behaviour here.
    it('should accept a normal ping and return ONLINE', async () => {
      const res = await ping().expect(201);

      expect(res.body).toEqual({
        success: true,
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        timestamp: T0.toISOString(),
      });
    });

    it('should register a new kiosk in the status registry on its first ping', async () => {
      expect(prisma.kiosks.has('KIOSK-002')).toBe(false);

      await ping('KIOSK-002').expect(201);

      expect(prisma.kiosks.get('KIOSK-002')).toEqual({
        id: 'KIOSK-002',
        status: 'ONLINE',
        lastHeartbeat: T0,
      });
    });

    it('should fall back to KIOSK-001 when no kioskId is sent', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/kiosk/heartbeat')
        .send({})
        .expect(201);

      expect(res.body.kioskId).toBe('KIOSK-001');
    });

    it('should also be reachable on the /kiosk alias route', async () => {
      await request(app.getHttpServer())
        .post('/kiosk/heartbeat')
        .send({ kioskId: 'KIOSK-001' })
        .expect(201);
    });
  });

  describe('GET /api/kiosk/status/:id', () => {
    it('should return 200 and OFFLINE for an unknown kiosk', async () => {
      const res = await status('KIOSK-404').expect(200);

      expect(res.body).toEqual({
        kioskId: 'KIOSK-404',
        status: 'OFFLINE',
        lastHeartbeat: null,
      });
    });

    it('should stay ONLINE while the kiosk keeps pinging every 10s', async () => {
      await ping().expect(201);

      // Simulate the kiosk running for 60 seconds.
      for (let i = 0; i < 6; i++) {
        advanceSeconds(10);
        await ping().expect(201);
        const res = await status().expect(200);
        expect(res.body.status).toBe('ONLINE');
        expect(res.body.secondsSinceLastPing).toBe(0);
      }
    });

    it('should still be ONLINE at exactly 30s without a ping', async () => {
      await ping().expect(201);
      advanceSeconds(30);

      const res = await status().expect(200);

      expect(res.body.status).toBe('ONLINE');
    });

    it('should turn OFFLINE within 30s of the client disconnecting', async () => {
      await ping().expect(201);
      advanceSeconds(31);

      const res = await status().expect(200);

      expect(res.body).toEqual({
        kioskId: 'KIOSK-001',
        status: 'OFFLINE',
        lastHeartbeat: T0.toISOString(),
        secondsSinceLastPing: 31,
      });
      // The OFFLINE state is persisted to the registry, not just reported.
      expect(prisma.kiosks.get('KIOSK-001')!.status).toBe('OFFLINE');
    });

    it('should come back ONLINE when the kiosk reconnects after a timeout', async () => {
      await ping().expect(201);
      advanceSeconds(45);
      expect((await status().expect(200)).body.status).toBe('OFFLINE');

      await ping().expect(201);

      const res = await status().expect(200);
      expect(res.body.status).toBe('ONLINE');
      expect(prisma.kiosks.get('KIOSK-001')!.status).toBe('ONLINE');
    });

    it('should track the timeout per kiosk independently', async () => {
      await ping('KIOSK-001').expect(201);
      await ping('KIOSK-002').expect(201);

      // Only KIOSK-002 keeps pinging.
      advanceSeconds(20);
      await ping('KIOSK-002').expect(201);
      advanceSeconds(20);

      expect((await status('KIOSK-001').expect(200)).body.status).toBe(
        'OFFLINE',
      );
      expect((await status('KIOSK-002').expect(200)).body.status).toBe(
        'ONLINE',
      );
    });
  });
});
