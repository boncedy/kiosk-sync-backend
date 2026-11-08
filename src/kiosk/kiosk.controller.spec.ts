import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { IngestLogDto } from './dto/ingest-log.dto';

describe('KioskController', () => {
  let controller: KioskController;
  let service: {
    ingestLog: jest.Mock;
    getConnectionState: jest.Mock;
    handleHeartbeat: jest.Mock;
    getKioskStatus: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      ingestLog: jest.fn(),
      getConnectionState: jest.fn(),
      handleHeartbeat: jest.fn(),
      getKioskStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [KioskController],
      providers: [{ provide: KioskService, useValue: service }],
    }).compile();

    controller = module.get<KioskController>(KioskController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /logs and /daily-submission (ingestLog)', () => {
    const dto: IngestLogDto = {
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      operatorId: 'OP-100',
      meterVolume: 42.5,
      reportedCash: 350.0,
      recordedAt: '2026-10-16T10:00:00.000Z',
      checksum: 'abc123',
    };

    const ackFor = (duplicate: boolean) => ({
      success: true,
      ack: true,
      status: 'SYNCHRONIZED',
      duplicate,
      logId: 'uuid-1',
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      operatorId: 'OP-100',
      meterVolume: 42.5,
      reportedCash: 350.0,
      recordedAt: new Date('2026-10-16T10:00:00.000Z'),
      createdAt: new Date(),
      receipt: {
        receiptId: 'RCPT-12345',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-100',
        meterVolume: 42.5,
        reportedCash: 350.0,
        recordedAt: '2026-10-16T10:00:00.000Z',
        checksum: 'checksum-hash',
        signature: 'signature-hex',
        algorithm: 'SHA-256',
        issuedAt: new Date().toISOString(),
      },
    });

    const mockResponse = () =>
      ({ status: jest.fn().mockReturnThis() }) as unknown as Response & {
        status: jest.Mock;
      };

    it('should call kioskService.ingestLog and return the ACK with signed receipt (default 201)', async () => {
      const expected = ackFor(false);
      service.ingestLog.mockResolvedValue(expected);
      const res = mockResponse();

      const result = await controller.ingestLog(dto, res);

      expect(result).toEqual(expected);
      expect(result.receipt).toBeDefined();
      expect(result.receipt!.checksum).toBe('checksum-hash');
      expect(service.ingestLog).toHaveBeenCalledWith(dto);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should answer 200 when re-acknowledging an already stored record (Story 14-3)', async () => {
      const expected = ackFor(true);
      service.ingestLog.mockResolvedValue(expected);
      const res = mockResponse();

      const result = await controller.ingestLog(dto, res);

      expect(result).toEqual(expected);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
