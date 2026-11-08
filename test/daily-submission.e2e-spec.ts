import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { ImgbbService } from '../src/kiosk/imgbb.service';
import { computeReceiptChecksum, verifyReceiptSignature } from '../src/kiosk/receipt';

describe('Daily Submission & Tamper-Evident Receipt E2E', () => {
  let app: INestApplication;
  const imgbbImageUrl = 'https://i.ibb.co/abcd1234/meter.jpg';
  const mockImgbb = {
    isConfigured: jest.fn().mockReturnValue(true),
    upload: jest.fn(),
  };
  const mockPrisma = {
    kiosk: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    dailyLog: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(ImgbbService)
      .useValue(mockImgbb)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockImgbb.isConfigured.mockReturnValue(true);
    mockImgbb.upload.mockResolvedValue({
      url: imgbbImageUrl,
      displayUrl: 'https://ibb.co/abcd1234',
    });
    mockPrisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
    mockPrisma.dailyLog.findUnique.mockResolvedValue(null);
    mockPrisma.dailyLog.findFirst.mockResolvedValue(null);
    mockPrisma.dailyLog.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'mock-log-uuid-1',
        ...data,
        createdAt: new Date(),
      }),
    );
  });

  it('accepts decreasing DAILY_VOLUME readings through the validation pipe', async () => {
    mockPrisma.dailyLog.findFirst.mockResolvedValue({
      transactionId: 'TXN-OLDER',
      meterVolume: 50,
      recordedAt: new Date('2026-11-04T09:00:00.000Z'),
    });

    const res = await request(app.getHttpServer())
      .post('/api/kiosk/logs')
      .send({
        transactionId: 'TXN-DAILY-VOLUME-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-077',
        readingType: 'DAILY_VOLUME',
        meterVolume: 12.5,
        reportedCash: 20,
        recordedAt: '2026-11-04T10:00:00.000Z',
      })
      .expect(201);

    expect(res.body.ack).toBe(true);
    expect(res.body.meterVolume).toBe(12.5);
    expect(mockPrisma.dailyLog.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.dailyLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          transactionId: 'TXN-DAILY-VOLUME-001',
          meterVolume: 12.5,
        }),
      }),
    );
  });

  it('uploads evidence to imgBB and persists its public URL with the log', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff]);
    const upload = await request(app.getHttpServer())
      .post('/api/kiosk/logs/TXN-EVIDENCE-001/evidence')
      .attach('file', image, {
        filename: 'meter.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);

    expect(upload.body.proofImageUrl).toBe(imgbbImageUrl);
    expect(mockImgbb.upload).toHaveBeenCalledTimes(1);

    const logResponse = await request(app.getHttpServer())
      .post('/api/kiosk/logs')
      .send({
        transactionId: 'TXN-EVIDENCE-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-077',
        readingType: 'DAILY_VOLUME',
        meterVolume: 12.5,
        reportedCash: 20,
        proofImageUrl: imgbbImageUrl,
        recordedAt: '2026-11-04T10:00:00.000Z',
      })
      .expect(201);

    expect(logResponse.body.proofImageUrl).toBe(imgbbImageUrl);
    expect(mockPrisma.dailyLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ proofImageUrl: imgbbImageUrl }),
      }),
    );
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects a proofImageUrl that is not hosted by imgBB', async () => {
    await request(app.getHttpServer())
      .post('/api/kiosk/logs')
      .send({
        transactionId: 'TXN-EVIDENCE-002',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-077',
        readingType: 'DAILY_VOLUME',
        meterVolume: 10,
        recordedAt: '2026-11-04T10:05:00.000Z',
        reportedCash: 20,
        proofImageUrl: 'https://evil.example.com/meter.jpg',
      })
      .expect(400);
  });

  it('normalizes a lowercase operatorId and rejects a malformed one', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/api/kiosk/logs')
      .send({
        transactionId: 'TXN-OPERATOR-FORMAT-1',
        kioskId: 'KIOSK-001',
        operatorId: 'op-042',
        readingType: 'DAILY_VOLUME',
        meterVolume: 10,
        reportedCash: 20,
        recordedAt: '2026-11-04T11:00:00.000Z',
      })
      .expect(201);

    expect(accepted.body.receipt.operatorId).toBe('OP-042');
    expect(mockPrisma.dailyLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operatorId: 'OP-042' }),
      }),
    );

    for (const operatorId of ['OP-42', '042', 'OP-0042', 'OPERATOR-1']) {
      await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send({
          transactionId: `TXN-OPERATOR-FORMAT-${operatorId}`,
          kioskId: 'KIOSK-001',
          operatorId,
          readingType: 'DAILY_VOLUME',
          meterVolume: 10,
          reportedCash: 20,
          recordedAt: '2026-11-04T11:01:00.000Z',
        })
        .expect(400);
    }
  });

  describe('POST /api/kiosk/logs with operatorId & reportedCash', () => {
    it('accepts operatorId and reportedCash, returning signed receipt with SHA-256 checksum', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-077',
        meterVolume: 150.75,
        reportedCash: 2450.0,
        recordedAt: '2026-11-04T10:00:00.000Z',
      };

      const expectedChecksum = computeReceiptChecksum({
        kioskId: payload.kioskId,
        operatorId: payload.operatorId,
        meterVolume: payload.meterVolume,
        reportedCash: payload.reportedCash,
        recordedAt: payload.recordedAt,
      });

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.ack).toBe(true);
      expect(res.body.status).toBe('SYNCHRONIZED');
      expect(res.body.operatorId).toBe('OP-077');
      expect(res.body.reportedCash).toBe(2450.0);
      expect(res.body.receipt).toBeDefined();

      const receipt = res.body.receipt;
      expect(receipt.kioskId).toBe('KIOSK-001');
      expect(receipt.operatorId).toBe('OP-077');
      expect(receipt.meterVolume).toBe(150.75);
      expect(receipt.reportedCash).toBe(2450.0);
      expect(receipt.recordedAt).toBe('2026-11-04T10:00:00.000Z');
      expect(receipt.checksum).toBe(expectedChecksum);
      expect(receipt.hash).toBe(expectedChecksum);
      expect(receipt.algorithm).toBe('SHA-256');
      expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);

      expect(verifyReceiptSignature(receipt.checksum, receipt.signature)).toBe(true);
    });

    it('rejects negative reportedCash with HTTP 400', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-ERR-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-077',
        meterVolume: 150.75,
        reportedCash: -100,
        recordedAt: '2026-11-04T10:00:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('reportedCash must be non-negative');
    });
  });

  describe('POST /api/kiosk/daily-submission (alias route)', () => {
    it('accepts daily submission via /api/kiosk/daily-submission and returns signed receipt', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-SUB-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-001',
        meterVolume: 88.0,
        reportedCash: 500,
        recordedAt: '2026-11-04T11:00:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/daily-submission')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.receipt).toBeDefined();
      expect(res.body.receipt.operatorId).toBe('OP-001');
      expect(res.body.receipt.reportedCash).toBe(500);
      expect(verifyReceiptSignature(res.body.receipt.checksum, res.body.receipt.signature)).toBe(true);
    });
  });

  describe('POST /daily-submission (direct route)', () => {
    it('accepts daily submission via /daily-submission and returns signed receipt', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-SUB-002',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-002',
        meterVolume: 92.5,
        reportedCash: 1000,
        recordedAt: '2026-11-04T11:30:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/daily-submission')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.receipt).toBeDefined();
      expect(res.body.receipt.operatorId).toBe('OP-002');
      expect(res.body.receipt.reportedCash).toBe(1000);
      expect(verifyReceiptSignature(res.body.receipt.checksum, res.body.receipt.signature)).toBe(true);
    });
  });
});
