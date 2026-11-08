import { Test, TestingModule } from '@nestjs/testing';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';

// Story 01 – Unit tests for heartbeat ping and disconnection timeout.
// Only Date is faked so we can move the clock without waiting 30 real seconds.
describe('KioskService – heartbeat & disconnection timeout (Story 01)', () => {
  const T0 = new Date('2026-10-16T10:00:00.000Z');

  let service: KioskService;
  let prisma: {
    kiosk: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
  };

  const advanceSeconds = (seconds: number) =>
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(T0);

    prisma = {
      kiosk: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [KioskService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<KioskService>(KioskService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── handleHeartbeat ──────────────────────────────────────

  describe('handleHeartbeat', () => {
    it('should mark the kiosk ONLINE and record the current time as lastHeartbeat', async () => {
      prisma.kiosk.upsert.mockImplementation(({ create }) =>
        Promise.resolve({ ...create }),
      );

      const result = await service.handleHeartbeat('KIOSK-001');

      expect(prisma.kiosk.upsert).toHaveBeenCalledWith({
        where: { id: 'KIOSK-001' },
        update: { status: 'ONLINE', lastHeartbeat: T0 },
        create: { id: 'KIOSK-001', status: 'ONLINE', lastHeartbeat: T0 },
      });
      expect(result).toEqual({
        success: true,
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        timestamp: T0,
      });
    });

    it('should refresh lastHeartbeat on every consecutive ping', async () => {
      prisma.kiosk.upsert.mockImplementation(({ update }) =>
        Promise.resolve({ id: 'KIOSK-001', ...update }),
      );

      await service.handleHeartbeat('KIOSK-001');
      advanceSeconds(10);
      const second = await service.handleHeartbeat('KIOSK-001');

      expect(prisma.kiosk.upsert).toHaveBeenCalledTimes(2);
      expect(second.timestamp).toEqual(new Date(T0.getTime() + 10_000));
    });
  });

  // ─── getKioskStatus ───────────────────────────────────────

  describe('getKioskStatus', () => {
    const kioskPingedAt = (lastHeartbeat: Date, status = 'ONLINE') => ({
      id: 'KIOSK-001',
      status,
      lastHeartbeat,
    });

    it('should report OFFLINE for a kiosk that has never been registered', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(null);

      const result = await service.getKioskStatus('KIOSK-404');

      expect(result).toEqual({
        kioskId: 'KIOSK-404',
        status: 'OFFLINE',
        lastHeartbeat: null,
      });
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should report OFFLINE for a kiosk that has never sent a heartbeat', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({
        id: 'KIOSK-001',
        status: 'OFFLINE',
        lastHeartbeat: null,
      });

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(result.lastHeartbeat).toBeNull();
    });

    it('should report ONLINE right after a heartbeat', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result).toEqual({
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        lastHeartbeat: T0,
        secondsSinceLastPing: 0,
      });
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should stay ONLINE at 10s (one missed 10s interval is not a disconnect)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(10);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('ONLINE');
      expect(result.secondsSinceLastPing).toBe(10);
    });

    it('should stay ONLINE at exactly 30s (boundary)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(30);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('ONLINE');
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should switch to OFFLINE and persist it once no ping for more than 30s', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(31);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(result.secondsSinceLastPing).toBe(31);
      expect(prisma.kiosk.update).toHaveBeenCalledWith({
        where: { id: 'KIOSK-001' },
        data: { status: 'OFFLINE' },
      });
    });

    it('should not write to the DB again when the kiosk is already stored as OFFLINE', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0, 'OFFLINE'));
      advanceSeconds(120);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should propagate DB errors instead of silently reporting a status', async () => {
      prisma.kiosk.findUnique.mockRejectedValue(new Error('DB down'));

      await expect(service.getKioskStatus('KIOSK-001')).rejects.toThrow(
        'DB down',
      );
    });
  });
});
