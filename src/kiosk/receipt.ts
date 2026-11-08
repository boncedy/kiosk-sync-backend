import * as crypto from 'crypto';

export interface ReceiptPayloadInput {
  kioskId: string;
  operatorId?: string | null;
  meterVolume: number;
  reportedCash?: number | null;
  recordedAt: string | Date;
}

/**
 * Builds the canonical message string for the receipt SHA-256 checksum:
 * kioskId + operatorId + meterVolume + reportedCash + recordedAt
 */
export function buildReceiptChecksumString(input: ReceiptPayloadInput): string {
  const kioskId = String(input.kioskId ?? '').trim();
  const operatorId =
    input.operatorId !== undefined && input.operatorId !== null
      ? String(input.operatorId).trim()
      : '';
  const meterVolume = input.meterVolume;
  const reportedCash =
    input.reportedCash !== undefined && input.reportedCash !== null
      ? input.reportedCash
      : '';

  let recordedAt: string;
  if (input.recordedAt instanceof Date) {
    recordedAt = input.recordedAt.toISOString();
  } else if (input.recordedAt) {
    recordedAt = String(input.recordedAt).trim();
  } else {
    recordedAt = new Date().toISOString();
  }

  return `${kioskId}${operatorId}${meterVolume}${reportedCash}${recordedAt}`;
}

/**
 * Computes server-side SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt)
 */
export function computeReceiptChecksum(input: ReceiptPayloadInput): string {
  const message = buildReceiptChecksumString(input);
  return crypto.createHash('sha256').update(message).digest('hex');
}

/**
 * Signs the checksum using HMAC-SHA256 with the server's signing key.
 */
export function signReceiptChecksum(checksum: string, secret?: string): string {
  const key =
    secret ||
    process.env.RECEIPT_SIGNING_KEY ||
    process.env.RECEIPT_SECRET ||
    'namsa-ard-kiosk-receipt-secret-key';
  return crypto.createHmac('sha256', key).update(checksum).digest('hex');
}

/**
 * Verifies a receipt signature against the computed checksum.
 */
export function verifyReceiptSignature(
  checksum: string,
  signature: string,
  secret?: string,
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signReceiptChecksum(checksum, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.toLowerCase(), 'hex'),
      Buffer.from(expected.toLowerCase(), 'hex'),
    );
  } catch {
    return false;
  }
}

export interface SignedReceipt {
  receiptId: string;
  transactionId?: string;
  kioskId: string;
  operatorId: string;
  meterVolume: number;
  reportedCash: number;
  recordedAt: string;
  checksum: string;
  hash: string;
  signature: string;
  algorithm: string;
  issuedAt: string;
  signedAt: string;
}

/**
 * Generates a signed tamper-evident receipt object.
 */
export function generateSignedReceipt(
  input: ReceiptPayloadInput & { transactionId?: string; receiptId?: string },
  secret?: string,
): SignedReceipt {
  const checksum = computeReceiptChecksum(input);
  const signature = signReceiptChecksum(checksum, secret);
  const now = new Date().toISOString();

  let recordedAtStr: string;
  if (input.recordedAt instanceof Date) {
    recordedAtStr = input.recordedAt.toISOString();
  } else if (input.recordedAt) {
    recordedAtStr = String(input.recordedAt).trim();
  } else {
    recordedAtStr = now;
  }

  return {
    receiptId: input.receiptId || `RCPT-${crypto.randomUUID()}`,
    transactionId: input.transactionId,
    kioskId: input.kioskId,
    operatorId:
      input.operatorId !== undefined && input.operatorId !== null
        ? String(input.operatorId).trim()
        : '',
    meterVolume: Number(input.meterVolume),
    reportedCash:
      input.reportedCash !== undefined && input.reportedCash !== null
        ? Number(input.reportedCash)
        : 0,
    recordedAt: recordedAtStr,
    checksum,
    hash: checksum,
    signature,
    algorithm: 'SHA-256',
    issuedAt: now,
    signedAt: now,
  };
}
