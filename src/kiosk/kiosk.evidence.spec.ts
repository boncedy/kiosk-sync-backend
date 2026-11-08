import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { KioskService, isAcceptableProofImageUrl } from './kiosk.service';
import { EvidenceStorageUnavailableError } from './imgbb.service';

describe('KioskService evidence storage (imgBB)', () => {
  const image = Buffer.from([0xff, 0xd8, 0xff]);
  const transactionId = 'TX-123';
  const imgbbUrl = 'https://i.ibb.co/abcd1234/meter.jpg';

  let prisma: { $executeRaw: jest.Mock };
  let imgbb: { isConfigured: jest.Mock; upload: jest.Mock };
  let service: KioskService;

  beforeEach(() => {
    prisma = {
      $executeRaw: jest.fn(),
    };
    imgbb = {
      isConfigured: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockResolvedValue({
        url: imgbbUrl,
        displayUrl: 'https://ibb.co/abcd1234',
      }),
    };
    service = new KioskService(prisma as never, imgbb as never);
  });

  it('hands the photo to imgBB and returns its public URL without writing to PostgreSQL', async () => {
    await expect(
      service.uploadEvidence(transactionId, {
        buffer: image,
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).resolves.toEqual({ proofImageUrl: imgbbUrl });

    expect(imgbb.upload).toHaveBeenCalledTimes(1);
    expect(imgbb.upload.mock.calls[0][0]).toBe(image);
    expect(imgbb.upload.mock.calls[0][1]).toBe('kiosk-TX-123.jpg');
    expect(imgbb.upload.mock.calls[0][2]).toBe('image/jpeg');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects invalid image content even when the declared type is allowed', async () => {
    await expect(
      service.uploadEvidence(transactionId, {
        buffer: Buffer.from('not an image'),
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(imgbb.upload).not.toHaveBeenCalled();
  });

  it('rejects photos larger than 5 MB before calling imgBB', async () => {
    await expect(
      service.uploadEvidence(transactionId, {
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
        mimetype: 'image/jpeg',
        originalname: 'huge.jpg',
      }),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(imgbb.upload).not.toHaveBeenCalled();
  });

  it('rejects unsafe transaction ids before calling imgBB', async () => {
    await expect(
      service.uploadEvidence('../other', {
        buffer: image,
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(imgbb.upload).not.toHaveBeenCalled();
  });

  it('returns 503 when imgBB is not configured so the client keeps the entry queued', async () => {
    imgbb.isConfigured.mockReturnValue(false);

    const upload = service.uploadEvidence(transactionId, {
      buffer: image,
      mimetype: 'image/jpeg',
      originalname: 'meter.jpg',
    });

    await expect(upload).rejects.toThrow(ServiceUnavailableException);
    await expect(upload).rejects.toThrow(
      'Evidence storage is not configured on the server.',
    );
    expect(imgbb.upload).not.toHaveBeenCalled();
  });

  it('returns 503 when imgBB rejects or cannot be reached', async () => {
    imgbb.upload.mockRejectedValue(
      new EvidenceStorageUnavailableError(
        'imgBB rejected the upload: You have been forbidden to use this website.',
      ),
    );

    await expect(
      service.uploadEvidence(transactionId, {
        buffer: image,
        mimetype: 'image/jpeg',
        originalname: 'meter.jpg',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

});

describe('proofImageUrl validation', () => {
  it('accepts an imgBB image URL', () => {
    expect(
      isAcceptableProofImageUrl('https://i.ibb.co/abcd1234/meter.jpg'),
    ).toBe(true);
    expect(isAcceptableProofImageUrl('https://ibb.co/abcd1234')).toBe(true);
  });

  it('rejects other hosts and insecure schemes', () => {
    for (const value of [
      'https://evil.example.com/meter.jpg',
      'http://i.ibb.co/abcd1234/meter.jpg',
      'https://i.ibb.co.evil.example/meter.jpg',
      `/api/kiosk/logs/OTHER/evidence/${'a'.repeat(64)}.jpg`,
      'not a url',
    ]) {
      expect(isAcceptableProofImageUrl(value)).toBe(false);
    }
  });
});
