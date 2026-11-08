import { Injectable, Logger } from '@nestjs/common';

const DEFAULT_UPLOAD_URL = 'https://api.imgbb.com/1/upload';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Phone photos are multi-megabyte and imgBB can be slow to ingest them on
 * mobile links, so the upload budget stays generous. Override with
 * IMGBB_TIMEOUT_MS when running against a faster or slower network.
 */
function uploadTimeoutMs(): number {
  const configured = Number(process.env.IMGBB_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Raised when evidence cannot be handed to imgBB (missing key, network error,
 * rejected upload). The kiosk service turns this into a 503 so the operator
 * client keeps the reading and its photo queued for a later retry.
 */
export class EvidenceStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceStorageUnavailableError';
  }
}

export interface ImgbbUploadResult {
  /** Direct image URL (https://i.ibb.co/...) suitable for <img src> and links. */
  url: string;
  /** Human-facing imgBB page URL (https://ibb.co/...). */
  displayUrl: string;
}

interface ImgbbResponse {
  success?: boolean;
  status?: number;
  data?: {
    url?: string;
    display_url?: string;
    delete_url?: string;
  };
  error?: {
    message?: string;
    code?: number;
  };
}

/**
 * Thin client for the imgBB image hosting API (v1).
 *
 * Photos are stored by imgBB instead of PostgreSQL: only the returned URL is
 * persisted on `DailyLog.proofImageUrl`, so uploads are capped at 5 MB by the
 * caller and the database never carries image bytes.
 */
@Injectable()
export class ImgbbService {
  private readonly logger = new Logger(ImgbbService.name);

  /** The API key is read at call time so tests and dotenv reloads stay honest. */
  private apiKey(): string {
    return (process.env.IMGBB_API_KEY ?? '').trim();
  }

  isConfigured(): boolean {
    return this.apiKey().length > 0;
  }

  async upload(
    image: Buffer,
    fileName?: string,
    mimeType = 'application/octet-stream',
  ): Promise<ImgbbUploadResult> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      throw new EvidenceStorageUnavailableError(
        'IMGBB_API_KEY is not configured on the server.',
      );
    }

    const form = new FormData();
    // Binary upload avoids the ~33% base64 overhead, which matters for
    // multi-megabyte phone photos on mobile links.
    const bytes = new Uint8Array(image.byteLength);
    bytes.set(image);
    form.append('image', new Blob([bytes], { type: mimeType }), fileName ?? 'evidence');
    if (fileName) {
      form.append('name', fileName.replace(/[^\w.-]+/g, '-').slice(0, 100));
    }

    const endpoint = `${(process.env.IMGBB_UPLOAD_URL ?? '').trim() || DEFAULT_UPLOAD_URL}?key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(uploadTimeoutMs()),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`imgBB upload failed to reach the API: ${detail}`);
      throw new EvidenceStorageUnavailableError(
        `Could not reach imgBB: ${detail}`,
      );
    }

    let payload: ImgbbResponse;
    try {
      payload = (await response.json()) as ImgbbResponse;
    } catch {
      throw new EvidenceStorageUnavailableError(
        `imgBB returned an unreadable response (HTTP ${response.status}).`,
      );
    }

    const url = payload.data?.url;
    if (!response.ok || payload.success !== true || !url) {
      const detail =
        payload.error?.message ?? `HTTP ${response.status} from imgBB`;
      this.logger.warn(`imgBB rejected the upload: ${detail}`);
      throw new EvidenceStorageUnavailableError(
        `imgBB rejected the upload: ${detail}`,
      );
    }

    return {
      url,
      displayUrl: payload.data?.display_url ?? url,
    };
  }
}
