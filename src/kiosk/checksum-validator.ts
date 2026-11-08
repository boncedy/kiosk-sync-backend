import * as crypto from 'crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  computeReceiptChecksum,
  generateSignedReceipt,
  signReceiptChecksum,
  verifyReceiptSignature,
  type SignedReceipt,
  type ReceiptPayloadInput,
} from './receipt';

export {
  computeReceiptChecksum,
  generateSignedReceipt,
  signReceiptChecksum,
  verifyReceiptSignature,
};
export type { SignedReceipt, ReceiptPayloadInput };

// ───────────────────────────────────────────────────────────
//  Story 14-2 – Offline Data Corrupted Checker (SCRUM-23)
//  Recomputes the SHA-256 hash on the server and rejects
//  corrupted or tampered records with HTTP 422 Unprocessable Entity.
// ───────────────────────────────────────────────────────────

export const CORRUPTED_PAYLOAD = 'CORRUPTED_PAYLOAD';

export type ChecksumAlgorithmVersion = 'v1' | 'legacy';

export interface ChecksumPayload {
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: string | Date;
  operatorId?: string;
  reportedCash?: number;
}

/**
 * Normalizes payload fields into deterministic primitives.
 */
export function normalizeChecksumFields(payload: ChecksumPayload): {
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: string;
} {
  const transactionId = String(payload.transactionId || '').trim();
  const kioskId = String(payload.kioskId || '').trim();
  const meterVolume = Number(payload.meterVolume ?? 0);
  const rawRecorded = payload.recordedAt;

  let recordedAt: string;
  if (rawRecorded instanceof Date) {
    recordedAt = rawRecorded.toISOString();
  } else if (rawRecorded) {
    const parsed = new Date(rawRecorded);
    recordedAt = isNaN(parsed.getTime()) ? String(rawRecorded).trim() : parsed.toISOString();
  } else {
    recordedAt = new Date().toISOString();
  }

  return { transactionId, kioskId, meterVolume, recordedAt };
}

/**
 * Produces a deterministic canonical string representation of the payload.
 * Supports:
 *  - 'v1': `v1|kiosk:${kioskId}|meter:${normalizedVolume}|recorded:${recordedAt}|txn:${transactionId}`
 *  - 'legacy': `${transactionId}${kioskId}${meterVolume}`
 */
export function canonicalizePayload(
  payload: ChecksumPayload,
  version: ChecksumAlgorithmVersion = 'v1',
): string {
  const { transactionId, kioskId, meterVolume, recordedAt } =
    normalizeChecksumFields(payload);

  if (version === 'legacy') {
    return `${transactionId}${kioskId}${meterVolume}`;
  }

  // Version 1 canonical string: sorted key pairs separated by '|'
  const normalizedVolume = Number.isFinite(meterVolume)
    ? meterVolume.toFixed(4)
    : '0.0000';
  return `v1|kiosk:${kioskId}|meter:${normalizedVolume}|recorded:${recordedAt}|txn:${transactionId}`;
}

/**
 * Computes SHA-256 hash in hexadecimal format for a transaction payload.
 */
export function computePayloadChecksum(
  payload: ChecksumPayload,
  version: ChecksumAlgorithmVersion = 'v1',
): string {
  const canonicalString = canonicalizePayload(payload, version);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Verifies if the client-provided checksum matches the server-recomputed SHA-256 hash.
 * Supports version-prefixed checksums (e.g. "v1:<hex>", "legacy:<hex>")
 * as well as unprefixed checksums (checking v1, legacy, or receipt checksum).
 */
export function verifyPayloadChecksum(
  payload: ChecksumPayload,
  expectedChecksum: string,
): boolean {
  if (!expectedChecksum || typeof expectedChecksum !== 'string') {
    return false;
  }

  const trimmed = expectedChecksum.trim();
  if (!trimmed) {
    return false;
  }

  // Check for explicit version prefix
  if (trimmed.startsWith('v1:')) {
    const cleanHash = trimmed.slice(3).toLowerCase();
    const v1Hash = computePayloadChecksum(payload, 'v1').toLowerCase();
    return cleanHash === v1Hash;
  }

  if (trimmed.startsWith('legacy:')) {
    const cleanHash = trimmed.slice(7).toLowerCase();
    const legacyHash = computePayloadChecksum(payload, 'legacy').toLowerCase();
    return cleanHash === legacyHash;
  }

  const cleanHash = trimmed.toLowerCase();

  // Try v1 first (the current standard)
  const v1Hash = computePayloadChecksum(payload, 'v1').toLowerCase();
  if (cleanHash === v1Hash) {
    return true;
  }

  // Fallback to legacy format (SHA-256(transaction_id + kiosk_id + meter_volume))
  const legacyHash = computePayloadChecksum(payload, 'legacy').toLowerCase();
  if (cleanHash === legacyHash) {
    return true;
  }

  // Also support receipt format SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt)
  const receiptHash = computeReceiptChecksum({
    kioskId: payload.kioskId,
    operatorId: payload.operatorId,
    meterVolume: payload.meterVolume,
    reportedCash: payload.reportedCash,
    recordedAt: payload.recordedAt,
  }).toLowerCase();
  if (cleanHash === receiptHash) {
    return true;
  }

  return false;
}

/**
 * Builds the HTTP 422 Unprocessable Entity exception for corrupted payloads.
 *
 * Body format matches API specification:
 * `{ statusCode: 422, ack: false, error: "CORRUPTED_PAYLOAD", message }`
 */
export function toCorruptedPayloadException(
  message = 'Checksum mismatch or corrupted payload',
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    ack: false,
    error: CORRUPTED_PAYLOAD,
    message,
  });
}
