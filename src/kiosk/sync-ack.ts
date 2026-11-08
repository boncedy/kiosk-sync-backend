import { ConflictException } from '@nestjs/common';
import type { IncomingReading } from './meter-conflict';
import type { SignedReceipt } from './receipt';

// ───────────────────────────────────────────────────────────
//  Story 14-3 – Server ACK confirmation
//  Every stored record is confirmed with an explicit ACK, so the kiosk
//  only marks a local record "Synchronized" once the server says so:
//
//    201 Created  – new record stored
//                   { ack: true, status: "SYNCHRONIZED", duplicate: false }
//    200 OK       – identical retry of a stored record (its first ACK was lost)
//                   { ack: true, status: "SYNCHRONIZED", duplicate: true }
//    409 Conflict – transactionId already used for a different reading
//                   { ack: false, error: "DUPLICATE_TRANSACTION" }
// ───────────────────────────────────────────────────────────

export const SYNCHRONIZED = 'SYNCHRONIZED';

/** Error code for a reused transactionId. Distinct from `STATE_CONFLICT`. */
export const DUPLICATE_TRANSACTION = 'DUPLICATE_TRANSACTION';

export type WaterTypeValue = 'COMMERCIAL' | 'SUBSIDIZED';

export interface StoredLog {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId?: string | null;
  meterVolume: number;
  reportedCash?: number | null;
  expectedRevenue?: number | null;
  variance?: number | null;
  isAnomaly?: boolean | null;
  proofImageUrl?: string | null;
  waterType?: WaterTypeValue | null;
  isSynced?: boolean | null;
  isReadByManager?: boolean | null;
  recordedAt: Date;
  createdAt: Date;
}

export interface SyncAck {
  success: true;
  ack: true;
  status: typeof SYNCHRONIZED;
  /** True when an earlier attempt already stored the record. */
  duplicate: boolean;
  logId: string;
  transactionId: string;
  kioskId: string;
  operatorId?: string | null;
  meterVolume: number;
  reportedCash?: number | null;
  expectedRevenue?: number | null;
  variance?: number | null;
  isAnomaly?: boolean | null;
  proofImageUrl?: string | null;
  waterType?: WaterTypeValue | null;
  isReadByManager?: boolean | null;
  recordedAt: Date;
  /** Server-side timestamp of when the record was first stored. */
  createdAt: Date;
  /** Signed tamper-evident receipt object upon daily log submission. */
  receipt?: SignedReceipt;
}

/** Builds the ACK body for a record that is stored on the server. */
export function toSyncAck(
  log: StoredLog,
  duplicate: boolean,
  receipt?: SignedReceipt,
  operatorId?: string,
  reportedCash?: number,
): SyncAck {
  const ack: SyncAck = {
    success: true,
    ack: true,
    status: SYNCHRONIZED,
    duplicate,
    logId: log.id,
    transactionId: log.transactionId,
    kioskId: log.kioskId,
    meterVolume: log.meterVolume,
    recordedAt: log.recordedAt,
    createdAt: log.createdAt,
  };

  const resolvedOperatorId = operatorId ?? log.operatorId;
  if (resolvedOperatorId !== undefined && resolvedOperatorId !== null) {
    ack.operatorId = resolvedOperatorId;
  }

  const resolvedReportedCash = reportedCash ?? log.reportedCash;
  if (resolvedReportedCash !== undefined && resolvedReportedCash !== null) {
    ack.reportedCash = resolvedReportedCash;
  }

  if (log.expectedRevenue !== undefined && log.expectedRevenue !== null) {
    ack.expectedRevenue = log.expectedRevenue;
  }

  if (log.variance !== undefined && log.variance !== null) {
    ack.variance = log.variance;
  }

  if (log.isAnomaly !== undefined && log.isAnomaly !== null) {
    ack.isAnomaly = log.isAnomaly;
  }

  if (log.proofImageUrl !== undefined && log.proofImageUrl !== null) {
    ack.proofImageUrl = log.proofImageUrl;
  }

  if (log.waterType !== undefined && log.waterType !== null) {
    ack.waterType = log.waterType;
  }

  if (log.isReadByManager !== undefined && log.isReadByManager !== null) {
    ack.isReadByManager = log.isReadByManager;
  }

  if (receipt !== undefined) {
    ack.receipt = receipt;
  }

  return ack;
}

/**
 * True when `incoming` is a retry of `stored` (same kiosk, volume and instant),
 * as opposed to a different reading that reuses the transactionId.
 */
export function isSameReading(
  stored: StoredLog,
  incoming: IncomingReading,
): boolean {
  return (
    stored.kioskId === incoming.kioskId &&
    stored.meterVolume === incoming.meterVolume &&
    stored.recordedAt.getTime() === incoming.recordedAt.getTime()
  );
}

/**
 * Builds the `409 Conflict` response for a transactionId that is already
 * stored with a different reading. `ack: false` – the kiosk must not treat it
 * as synchronized.
 */
export function toDuplicateTransactionException(
  transactionId: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    ack: false,
    error: DUPLICATE_TRANSACTION,
    message:
      `A log with transactionId "${transactionId}" already exists. ` +
      `The stored reading differs from this one.`,
  });
}
