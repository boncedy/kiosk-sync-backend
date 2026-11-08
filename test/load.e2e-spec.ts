import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { computePayloadChecksum } from '../src/kiosk/checksum-validator';

describe('Database Write Operations Load & Concurrency Testing (Supabase)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const LOAD_KIOSK_ID = 'TEST-KIOSK-LOAD-001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);

    // Clean up stale load test records
    await prisma.dailyLog.deleteMany({
      where: { kioskId: LOAD_KIOSK_ID },
    });
    await prisma.kiosk.deleteMany({
      where: { id: LOAD_KIOSK_ID },
    });

    // Seed load test kiosk
    await prisma.kiosk.create({
      data: {
        id: LOAD_KIOSK_ID,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
      },
    });
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.dailyLog.deleteMany({
        where: { kioskId: LOAD_KIOSK_ID },
      });
      await prisma.kiosk.deleteMany({
        where: { id: LOAD_KIOSK_ID },
      });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors
    }
    await app.close();
  }, 60000);

  // ───────────────────────────────────────────────────────────
  // 1. Concurrent Write Load Test (100 Writes, Concurrency = 10)
  // ───────────────────────────────────────────────────────────
  it(
    'should sustain concurrent database writes and preserve 100% payload integrity in Supabase',
    async () => {
      const TOTAL_REQUESTS = 100;
      const CONCURRENCY = 10;

      const latencies: number[] = [];
      let successCount = 0;
      let failureCount = 0;

      const baseTime = Date.now();
      const payloads = Array.from({ length: TOTAL_REQUESTS }, (_, i) => {
        const txnId = `TXN-LOAD-${baseTime}-${i}`;
        const meterVolume = parseFloat((100 + i * 0.75).toFixed(2));
        const recordedAt = new Date(baseTime + i * 1000).toISOString();
        const checksum = computePayloadChecksum({
          transactionId: txnId,
          kioskId: LOAD_KIOSK_ID,
          meterVolume,
          recordedAt,
        });

        return {
          transactionId: txnId,
          kioskId: LOAD_KIOSK_ID,
          meterVolume,
          recordedAt,
          checksum,
        };
      });

      const startTime = performance.now();

      // Worker pool pattern for controlled concurrency
      let nextIndex = 0;
      const executeWorker = async () => {
        while (nextIndex < payloads.length) {
          const index = nextIndex++;
          const payload = payloads[index];

          const reqStart = performance.now();
          try {
            const res = await request(app.getHttpServer())
              .post('/api/kiosk/logs')
              .send(payload);

            const reqEnd = performance.now();
            latencies.push(reqEnd - reqStart);

            if (res.status === 201 && res.body.success === true) {
              successCount++;
            } else {
              failureCount++;
            }
          } catch {
            failureCount++;
          }
        }
      };

      const workers = Array.from({ length: CONCURRENCY }, () => executeWorker());
      await Promise.all(workers);

      const totalDurationSec = (performance.now() - startTime) / 1000;
      const throughputRps = (TOTAL_REQUESTS / totalDurationSec).toFixed(2);

      // Latency statistics
      latencies.sort((a, b) => a - b);
      const minLatency = latencies[0].toFixed(2);
      const maxLatency = latencies[latencies.length - 1].toFixed(2);
      const avgLatency = (
        latencies.reduce((acc, l) => acc + l, 0) / latencies.length
      ).toFixed(2);
      const p50 = latencies[Math.floor(latencies.length * 0.5)].toFixed(2);
      const p90 = latencies[Math.floor(latencies.length * 0.9)].toFixed(2);
      const p95 = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
      const p99 = latencies[Math.floor(latencies.length * 0.99)].toFixed(2);

      console.log('\n================ LOAD TEST RESULTS (Supabase DB Writes) ================');
      console.log(`Total Write Requests : ${TOTAL_REQUESTS}`);
      console.log(`Concurrency Level    : ${CONCURRENCY} concurrent workers`);
      console.log(`Successful Writes    : ${successCount}`);
      console.log(`Failed Writes        : ${failureCount}`);
      console.log(`Error Rate           : ${((failureCount / TOTAL_REQUESTS) * 100).toFixed(2)}%`);
      console.log(`Total Duration       : ${totalDurationSec.toFixed(2)}s`);
      console.log(`Write Throughput     : ${throughputRps} writes/sec`);
      console.log('------------------------- Latency Breakdown -------------------------');
      console.log(`  Min Latency        : ${minLatency} ms`);
      console.log(`  Average Latency    : ${avgLatency} ms`);
      console.log(`  Median (p50)       : ${p50} ms`);
      console.log(`  90th Percentile(p90): ${p90} ms`);
      console.log(`  95th Percentile(p95): ${p95} ms`);
      console.log(`  99th Percentile(p99): ${p99} ms`);
      console.log(`  Max Latency        : ${maxLatency} ms`);
      console.log('=======================================================================\n');

      // Assertions: 100% success rate under load
      expect(successCount).toBe(TOTAL_REQUESTS);
      expect(failureCount).toBe(0);

      // Direct Supabase Database Verification
      const writtenCount = await prisma.dailyLog.count({
        where: { kioskId: LOAD_KIOSK_ID },
      });
      expect(writtenCount).toBe(TOTAL_REQUESTS);

      // Spot check data integrity of first, middle, and last records in Supabase
      for (const idx of [0, Math.floor(TOTAL_REQUESTS / 2), TOTAL_REQUESTS - 1]) {
        const expected = payloads[idx];
        const dbRow = await prisma.dailyLog.findUnique({
          where: { transactionId: expected.transactionId },
        });

        expect(dbRow).not.toBeNull();
        expect(dbRow!.meterVolume).toBe(expected.meterVolume);
        expect(dbRow!.checksum).toBe(expected.checksum);
        expect(dbRow!.recordedAt.toISOString()).toBe(expected.recordedAt);
        expect(dbRow!.isSynced).toBe(true);
      }
    },
    180000,
  );

  // ───────────────────────────────────────────────────────────
  // 2. High-Concurrency Race Condition & Idempotency Stress Test
  // ───────────────────────────────────────────────────────────
  it(
    'should correctly handle simultaneous writes with duplicate transactionId without DB corruption',
    async () => {
      const RACE_TXN_ID = `TXN-RACE-${Date.now()}`;
      const PARALLEL_REQUESTS = 10;

      const payload = {
        transactionId: RACE_TXN_ID,
        kioskId: LOAD_KIOSK_ID,
        meterVolume: 500.0,
        recordedAt: new Date(Date.now() + 500000).toISOString(),
      };

      // Dispatch 10 identical requests simultaneously in parallel
      const responses = await Promise.all(
        Array.from({ length: PARALLEL_REQUESTS }, () =>
          request(app.getHttpServer()).post('/api/kiosk/logs').send(payload),
        ),
      );

      const statusCounts = responses.reduce<Record<number, number>>(
        (acc, res) => {
          acc[res.status] = (acc[res.status] || 0) + 1;
          return acc;
        },
        {},
      );

      console.log('Race Condition Status Distribution:', statusCounts);

      // Exactly 1 request must create the record (HTTP 201)
      expect(statusCounts[201]).toBe(1);

      // The remaining 9 identical retries are re-acknowledged (HTTP 200 duplicate ACK)
      expect(statusCounts[200]).toBe(PARALLEL_REQUESTS - 1);

      // Every request gets the same SYNCHRONIZED ACK for the one stored row
      const logIds = new Set(responses.map((res) => res.body.logId));
      expect(logIds.size).toBe(1);
      for (const res of responses) {
        expect(res.body).toMatchObject({
          ack: true,
          status: 'SYNCHRONIZED',
          transactionId: RACE_TXN_ID,
          duplicate: res.status === 200,
        });
      }

      // Supabase must contain strictly 1 record for this transaction
      const dbCount = await prisma.dailyLog.count({
        where: { transactionId: RACE_TXN_ID },
      });
      expect(dbCount).toBe(1);
    },
    60000,
  );
});
