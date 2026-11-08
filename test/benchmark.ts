import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import request from 'supertest';
import * as crypto from 'crypto';

interface BenchmarkStats {
  totalRequests: number;
  concurrency: number;
  successful: number;
  failed: number;
  errorRate: string;
  durationSec: string;
  throughputRps: string;
  minMs: string;
  avgMs: string;
  p50Ms: string;
  p90Ms: string;
  p95Ms: string;
  p99Ms: string;
  maxMs: string;
}

async function runBenchmark(totalRequests = 100, concurrency = 10) {
  console.log('------------------------------------------------------------');
  console.log(`Starting Supabase DB Write Benchmark...`);
  console.log(`Target Database: Supabase PostgreSQL (bqtdncaxewqvepoocxfg)`);
  console.log(`Requests: ${totalRequests} | Concurrency: ${concurrency}`);
  console.log('------------------------------------------------------------');

  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  const KIOSK_ID = 'BENCHMARK-KIOSK-001';

  try {
    // 1. Prepare benchmark kiosk in Supabase
    await prisma.dailyLog.deleteMany({ where: { kioskId: KIOSK_ID } });
    await prisma.kiosk.deleteMany({ where: { id: KIOSK_ID } });
    await prisma.kiosk.create({
      data: {
        id: KIOSK_ID,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
      },
    });

    // 2. Prepare test payloads with SHA-256 checksums
    const payloads = Array.from({ length: totalRequests }, (_, i) => {
      const txnId = `TXN-BENCH-${Date.now()}-${i}`;
      const meterVolume = parseFloat((10.0 + i * 0.25).toFixed(2));
      const recordedAt = new Date().toISOString();
      const raw = `${KIOSK_ID}:${txnId}:${meterVolume}:${recordedAt}`;
      const checksum = crypto.createHash('sha256').update(raw).digest('hex');

      return {
        transactionId: txnId,
        kioskId: KIOSK_ID,
        meterVolume,
        recordedAt,
        checksum,
      };
    });

    const latencies: number[] = [];
    let successful = 0;
    let failed = 0;
    let cursor = 0;

    const startTime = performance.now();

    const worker = async () => {
      while (cursor < payloads.length) {
        const item = payloads[cursor++];
        const reqStart = performance.now();
        try {
          const res = await request(app.getHttpServer())
            .post('/api/kiosk/logs')
            .send(item);
          const reqEnd = performance.now();
          latencies.push(reqEnd - reqStart);

          if (res.status === 201 && res.body.success === true) {
            successful++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const totalDurationSec = (performance.now() - startTime) / 1000;
    latencies.sort((a, b) => a - b);

    const stats: BenchmarkStats = {
      totalRequests,
      concurrency,
      successful,
      failed,
      errorRate: `${((failed / totalRequests) * 100).toFixed(2)}%`,
      durationSec: `${totalDurationSec.toFixed(2)}s`,
      throughputRps: `${(totalRequests / totalDurationSec).toFixed(2)} ops/sec`,
      minMs: `${latencies[0]?.toFixed(2) ?? 0} ms`,
      avgMs: `${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)} ms`,
      p50Ms: `${latencies[Math.floor(latencies.length * 0.5)]?.toFixed(2) ?? 0} ms`,
      p90Ms: `${latencies[Math.floor(latencies.length * 0.9)]?.toFixed(2) ?? 0} ms`,
      p95Ms: `${latencies[Math.floor(latencies.length * 0.95)]?.toFixed(2) ?? 0} ms`,
      p99Ms: `${latencies[Math.floor(latencies.length * 0.99)]?.toFixed(2) ?? 0} ms`,
      maxMs: `${latencies[latencies.length - 1]?.toFixed(2) ?? 0} ms`,
    };

    console.log('\n--- PERFORMANCE SUMMARY ---');
    console.table([stats]);

    // 3. Payload Integrity & Database Verification
    console.log('--- DATABASE INTEGRITY VERIFICATION ---');
    const dbCount = await prisma.dailyLog.count({ where: { kioskId: KIOSK_ID } });
    console.log(`Expected DB Writes : ${totalRequests}`);
    console.log(`Confirmed DB Rows  : ${dbCount}`);
    console.log(`Data Loss Rate     : ${dbCount === totalRequests ? '0.00% (PERFECT MATCH)' : 'MISMATCH'}`);

    // Verify sample records for precision and checksum fidelity
    const sample = await prisma.dailyLog.findFirst({
      where: { transactionId: payloads[0].transactionId },
    });

    console.log('\nSample Verified Record:');
    console.log({
      id: sample?.id,
      transactionId: sample?.transactionId,
      meterVolume: sample?.meterVolume,
      checksum: sample?.checksum,
      isSynced: sample?.isSynced,
      recordedAt: sample?.recordedAt,
      createdAt: sample?.createdAt,
    });

    // 4. Clean up test records
    await prisma.dailyLog.deleteMany({ where: { kioskId: KIOSK_ID } });
    await prisma.kiosk.deleteMany({ where: { id: KIOSK_ID } });
    console.log('\nCleaned up benchmark test rows from Supabase.');
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
}

const args = process.argv.slice(2);
const reqCount = parseInt(args[0], 10) || 50;
const concCount = parseInt(args[1], 10) || 5;

runBenchmark(reqCount, concCount).catch(console.error);
