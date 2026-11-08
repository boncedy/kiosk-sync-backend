import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { computePayloadChecksum } from '../src/kiosk/checksum-validator';

describe('Payload Integrity & Database Write Operations (e2e with Supabase)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const TEST_KIOSK_ID = 'TEST-KIOSK-INTEGRITY-001';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);

    // Clean up any stale test data from previous runs
    await prisma.dailyLog.deleteMany({
      where: { kioskId: TEST_KIOSK_ID },
    });
    await prisma.kiosk.deleteMany({
      where: { id: TEST_KIOSK_ID },
    });

    // Seed test kiosk in Supabase
    await prisma.kiosk.create({
      data: {
        id: TEST_KIOSK_ID,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
      },
    });
  }, 30000);

  afterAll(async () => {
    try {
      // Clean up test data from Supabase
      await prisma.dailyLog.deleteMany({
        where: { kioskId: TEST_KIOSK_ID },
      });
      await prisma.kiosk.deleteMany({
        where: { id: TEST_KIOSK_ID },
      });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors
    }
    await app.close();
  }, 30000);

  // ───────────────────────────────────────────────────────────
  // 1. Valid Payload Storage Integrity
  // ───────────────────────────────────────────────────────────
  describe('1. Valid Payload Ingestion & Direct Supabase Verification', () => {
    const txnId = 'TXN-INT-VALID-001';
    const recordedAtStr = '2026-10-16T14:30:00.000Z';
    const checksumHash = computePayloadChecksum({
      transactionId: txnId,
      kioskId: TEST_KIOSK_ID,
      meterVolume: 45.75,
      recordedAt: recordedAtStr,
    });

    it('should successfully write valid telemetry payload and return 201', async () => {
      const payload = {
        transactionId: txnId,
        kioskId: TEST_KIOSK_ID,
        meterVolume: 45.75,
        recordedAt: recordedAtStr,
        checksum: checksumHash,
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.transactionId).toBe(txnId);
      expect(res.body.kioskId).toBe(TEST_KIOSK_ID);
      expect(res.body.meterVolume).toBe(45.75);
      expect(new Date(res.body.recordedAt).toISOString()).toBe(recordedAtStr);
      expect(res.body.createdAt).toBeDefined();
    });

    it('should verify the row in Supabase database matches payload bit-for-bit', async () => {
      const dbRow = await prisma.dailyLog.findUnique({
        where: { transactionId: txnId },
      });

      expect(dbRow).not.toBeNull();
      expect(dbRow!.transactionId).toBe(txnId);
      expect(dbRow!.kioskId).toBe(TEST_KIOSK_ID);
      expect(dbRow!.meterVolume).toBe(45.75);
      expect(dbRow!.checksum).toBe(checksumHash);
      expect(dbRow!.isSynced).toBe(true);
      expect(dbRow!.recordedAt.toISOString()).toBe(recordedAtStr);
      expect(dbRow!.createdAt).toBeInstanceOf(Date);
    });

    it('should support payload without optional checksum (persisting null in DB)', async () => {
      const noChecksumTxn = 'TXN-INT-NO-CHECKSUM-001';
      const noChecksumRecordedAt = '2026-10-16T15:30:00.000Z';
      const payload = {
        transactionId: noChecksumTxn,
        kioskId: TEST_KIOSK_ID,
        meterVolume: 60.0,
        recordedAt: noChecksumRecordedAt,
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);

      const dbRow = await prisma.dailyLog.findUnique({
        where: { transactionId: noChecksumTxn },
      });
      expect(dbRow).not.toBeNull();
      expect(dbRow!.checksum).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────
  // 2. Malformed / Corrupted Payload Rejection
  // ───────────────────────────────────────────────────────────
  describe('2. Malformed / Corrupted Payload Rejection', () => {
    it('should reject payload missing transactionId (HTTP 400)', async () => {
      const payload = {
        kioskId: TEST_KIOSK_ID,
        meterVolume: 25.0,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('transactionId is required');
    });

    it('should reject payload missing kioskId (HTTP 400)', async () => {
      const payload = {
        transactionId: 'TXN-INT-ERR-001',
        meterVolume: 25.0,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('kioskId is required');
    });

    it('should reject payload with negative meterVolume (HTTP 400)', async () => {
      const payload = {
        transactionId: 'TXN-INT-ERR-002',
        kioskId: TEST_KIOSK_ID,
        meterVolume: -10.5,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('meterVolume must be positive');
    });

    it('should reject payload with zero meterVolume (HTTP 400)', async () => {
      const payload = {
        transactionId: 'TXN-INT-ERR-003',
        kioskId: TEST_KIOSK_ID,
        meterVolume: 0,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('meterVolume must be positive');
    });

    it('should reject non-numeric meterVolume (HTTP 400)', async () => {
      const payload = {
        transactionId: 'TXN-INT-ERR-004',
        kioskId: TEST_KIOSK_ID,
        meterVolume: 'one-hundred',
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('meterVolume must be a number');
    });

    it('should reject invalid ISO-8601 recordedAt (HTTP 400)', async () => {
      const payload = {
        transactionId: 'TXN-INT-ERR-005',
        kioskId: TEST_KIOSK_ID,
        meterVolume: 12.3,
        recordedAt: 'invalid-date-string',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain(
        'recordedAt must be a valid ISO-8601 date string',
      );
    });

    it('should strip unrecognized injected fields via ValidationPipe whitelist', async () => {
      const txnId = 'TXN-INT-STRIP-001';
      const payload = {
        transactionId: txnId,
        kioskId: TEST_KIOSK_ID,
        meterVolume: 70.0,
        recordedAt: new Date().toISOString(),
        maliciousAdminFlag: true,
        extraInjectedData: 'unauthorized',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);

      const dbRow = await prisma.dailyLog.findUnique({
        where: { transactionId: txnId },
      });
      expect(dbRow).not.toBeNull();
      // Verify stripped fields were not stored
      expect((dbRow as Record<string, unknown>).maliciousAdminFlag).toBeUndefined();
      expect((dbRow as Record<string, unknown>).extraInjectedData).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────
  // 3. Relational / Foreign Key Integrity
  // ───────────────────────────────────────────────────────────
  describe('3. Relational / Foreign Key Integrity', () => {
    it('should reject log ingestion for non-existent kiosk (HTTP 404)', async () => {
      const payload = {
        transactionId: 'TXN-INT-NONEXISTENT-001',
        kioskId: 'KIOSK-DOES-NOT-EXIST-999',
        meterVolume: 30.0,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(404);

      expect(res.body.message).toContain(
        'Kiosk "KIOSK-DOES-NOT-EXIST-999" not found',
      );

      // Verify no orphan record written to Supabase
      const dbRow = await prisma.dailyLog.findUnique({
        where: { transactionId: 'TXN-INT-NONEXISTENT-001' },
      });
      expect(dbRow).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────
  // 4. Idempotency & Duplicate Transaction Protection
  // ───────────────────────────────────────────────────────────
  describe('4. Idempotency & Duplicate Rejection', () => {
    const duplicateTxn = 'TXN-INT-DUP-001';
    let firstPayload: Record<string, unknown>;
    let firstLogId: string;

    it('should accept first submission of transaction', async () => {
      firstPayload = {
        transactionId: duplicateTxn,
        kioskId: TEST_KIOSK_ID,
        meterVolume: 88.8,
        recordedAt: new Date().toISOString(),
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(firstPayload)
        .expect(201);

      expect(res.body).toMatchObject({ ack: true, status: 'SYNCHRONIZED', duplicate: false });
      firstLogId = res.body.logId;
    });

    it('should re-acknowledge an identical retry with HTTP 200 (duplicate ACK) without a second row', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(firstPayload)
        .expect(200);

      expect(res.body).toMatchObject({
        ack: true,
        status: 'SYNCHRONIZED',
        duplicate: true,
        logId: firstLogId,
        transactionId: duplicateTxn,
      });

      const count = await prisma.dailyLog.count({
        where: { transactionId: duplicateTxn },
      });
      expect(count).toBe(1);
    });

    it('should reject the same transactionId with a different reading with HTTP 409 Conflict', async () => {
      const payload = { ...firstPayload, meterVolume: 99.9 };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(409);

      expect(res.body).toMatchObject({ ack: false, error: 'DUPLICATE_TRANSACTION' });
      expect(res.body.message).toContain(
        `A log with transactionId "${duplicateTxn}" already exists.`,
      );

      // Verify database still only has 1 record for this transactionId
      const count = await prisma.dailyLog.count({
        where: { transactionId: duplicateTxn },
      });
      expect(count).toBe(1);
    });
  });
});
