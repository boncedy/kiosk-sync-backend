import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { EvidenceStorageUnavailableError, ImgbbService } from './imgbb.service';

/**
 * Exercises the real HTTP client against a local stub that speaks the imgBB
 * response format, so request shaping and error mapping are covered without
 * touching the network.
 */
describe('ImgbbService', () => {
  let server: Server;
  let uploadUrl: string;
  let lastRequest: { url: string; contentType: string; raw: Buffer; body: string };
  let respond: (response: ServerResponse) => void;

  const originalKey = process.env.IMGBB_API_KEY;
  const originalUrl = process.env.IMGBB_UPLOAD_URL;
  const originalTimeout = process.env.IMGBB_TIMEOUT_MS;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks);
        lastRequest = {
          url: request.url ?? '',
          contentType: String(request.headers['content-type'] ?? ''),
          raw,
          body: raw.toString('utf8'),
        };
        respond(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    uploadUrl = `http://127.0.0.1:${port}/1/upload`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    process.env.IMGBB_API_KEY = 'test-key';
    process.env.IMGBB_UPLOAD_URL = uploadUrl;
    lastRequest = { url: '', contentType: '', raw: Buffer.alloc(0), body: '' };
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          data: {
            url: 'https://i.ibb.co/abcd1234/meter.jpg',
            display_url: 'https://ibb.co/abcd1234',
          },
        }),
      );
    };
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.IMGBB_API_KEY;
    else process.env.IMGBB_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.IMGBB_UPLOAD_URL;
    else process.env.IMGBB_UPLOAD_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.IMGBB_TIMEOUT_MS;
    else process.env.IMGBB_TIMEOUT_MS = originalTimeout;
  });

  it('posts the image bytes and file name to imgBB and returns the CDN URL', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33]);
    const result = await new ImgbbService().upload(
      image,
      'meter.jpg',
      'image/jpeg',
    );

    expect(result).toEqual({
      url: 'https://i.ibb.co/abcd1234/meter.jpg',
      displayUrl: 'https://ibb.co/abcd1234',
    });
    expect(lastRequest.url).toContain('key=test-key');
    expect(lastRequest.contentType).toContain('multipart/form-data');
    // Binary part, not base64: the raw bytes must appear verbatim in the body.
    expect(lastRequest.raw.includes(image)).toBe(true);
    expect(lastRequest.body).toContain('meter.jpg');
    expect(lastRequest.body).toContain('image/jpeg');
  });

  it('reports whether an API key is configured', () => {
    expect(new ImgbbService().isConfigured()).toBe(true);

    delete process.env.IMGBB_API_KEY;
    expect(new ImgbbService().isConfigured()).toBe(false);
  });

  it('throws a storage error when no API key is configured', async () => {
    delete process.env.IMGBB_API_KEY;

    await expect(new ImgbbService().upload(Buffer.from([0xff]))).rejects.toThrow(
      EvidenceStorageUnavailableError,
    );
  });

  it('surfaces the imgBB error message when the key is rejected', async () => {
    respond = (response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status_code: 400,
          error: {
            message: 'You have been forbidden to use this website.',
            code: 103,
          },
        }),
      );
    };

    const error = await new ImgbbService()
      .upload(Buffer.from([0xff]))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvidenceStorageUnavailableError);
    expect((error as Error).message).toContain('forbidden');
  });

  it('throws when imgBB returns an unreadable body', async () => {
    respond = (response) => {
      response.writeHead(502);
      response.end('<html>bad gateway</html>');
    };

    await expect(new ImgbbService().upload(Buffer.from([0xff]))).rejects.toThrow(
      /unreadable response/,
    );
  });

  it('throws when imgBB cannot be reached', async () => {
    process.env.IMGBB_UPLOAD_URL = 'http://127.0.0.1:1/1/upload';

    await expect(new ImgbbService().upload(Buffer.from([0xff]))).rejects.toThrow(
      /Could not reach imgBB/,
    );
  });

  it('honours IMGBB_TIMEOUT_MS when imgBB is too slow', async () => {
    process.env.IMGBB_TIMEOUT_MS = '50';
    respond = (response) => {
      setTimeout(() => {
        response.on('error', () => {});
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            success: true,
            data: { url: 'https://i.ibb.co/late/meter.jpg' },
          }),
        );
      }, 400);
    };

    await expect(new ImgbbService().upload(Buffer.from([0xff]))).rejects.toThrow(
      /Could not reach imgBB/,
    );
  });
});
