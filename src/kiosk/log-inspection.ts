import {
  computePayloadChecksum,
  computeReceiptChecksum,
  type ChecksumAlgorithmVersion,
} from './checksum-validator';

// ───────────────────────────────────────────────────────────
//  Story 05 – Read-only historical log inspection (Operation Managers)
//  Recomputes the SHA-256 checksum of a stored log from its current
//  database values and compares it with the checksum recorded at
//  submission. A row edited after submission no longer matches.
// ───────────────────────────────────────────────────────────

export const VERIFIED = 'VERIFIED';
export const CHECKSUM_MISMATCH = 'CHECKSUM_MISMATCH';
/** The log was stored without a checksum, so there is nothing to compare. */
export const NO_CHECKSUM = 'NO_CHECKSUM';

export type VerificationStatus =
  typeof VERIFIED | typeof CHECKSUM_MISMATCH | typeof NO_CHECKSUM;

/** Canonical form a stored checksum was computed with (see `checksum-validator.ts`). */
export type ChecksumFormat = ChecksumAlgorithmVersion | 'receipt';

/** A `daily_logs` row. Reconciliation fields are optional until ingestion stores them. */
export interface InspectableLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: Date;
  createdAt: Date;
  checksum: string | null;
  operatorId?: string | null;
  reportedCash?: number | null;
  expectedRevenue?: number | null;
  variance?: number | null;
  isAnomaly?: boolean | null;
  proofImageUrl?: string | null;
  waterType?: 'COMMERCIAL' | 'SUBSIDIZED' | null;
  isSynced?: boolean | null;
  isReadByManager?: boolean | null;
}

export interface ChecksumVerification {
  status: VerificationStatus;
  algorithm: 'SHA-256';
  /** Format the stored checksum matched, or the format it was checked against. */
  format: ChecksumFormat | null;
  storedChecksum: string | null;
  recomputedChecksum: string | null;
  verifiedAt: string;
}

export interface InspectedLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: Date;
  createdAt: Date;
  operatorId: string | null;
  reportedCash: number | null;
  expectedRevenue: number | null;
  variance: number | null;
  isAnomaly: boolean | null;
  proofImageUrl?: string | null;
  waterType?: 'COMMERCIAL' | 'SUBSIDIZED' | null;
  isSynced?: boolean | null;
  isReadByManager?: boolean | null;
}

export interface LogInspection {
  log: InspectedLog;
  verification: ChecksumVerification;
}

function recompute(log: InspectableLog, format: ChecksumFormat): string {
  if (format === 'receipt') {
    return computeReceiptChecksum({
      kioskId: log.kioskId,
      operatorId: log.operatorId,
      meterVolume: log.meterVolume,
      reportedCash: log.reportedCash,
      recordedAt: log.recordedAt,
    });
  }
  return computePayloadChecksum(
    {
      transactionId: log.transactionId,
      kioskId: log.kioskId,
      meterVolume: log.meterVolume,
      recordedAt: log.recordedAt,
    },
    format,
  );
}

/**
 * Checks a stored log against its stored checksum.
 *
 * Accepts the same formats as ingestion (`verifyPayloadChecksum`): a
 * `v1:`/`legacy:` prefix pins the format; an unprefixed checksum may match
 * v1, legacy or the receipt format.
 */
export function verifyStoredChecksum(
  log: InspectableLog,
  now: Date = new Date(),
): ChecksumVerification {
  const verifiedAt = now.toISOString();
  const stored = log.checksum?.trim() || null;

  if (!stored) {
    return {
      status: NO_CHECKSUM,
      algorithm: 'SHA-256',
      format: null,
      storedChecksum: null,
      recomputedChecksum: null,
      verifiedAt,
    };
  }

  const prefix = /^(v1|legacy):/i.exec(stored);
  const pinned = prefix
    ? (prefix[1].toLowerCase() as ChecksumAlgorithmVersion)
    : null;
  const storedHash = (prefix ? stored.slice(prefix[0].length) : stored)
    .trim()
    .toLowerCase();

  const formats: ChecksumFormat[] = pinned
    ? [pinned]
    : ['v1', 'legacy', 'receipt'];

  const attempts = formats.map((format) => ({
    format,
    checksum: recompute(log, format),
  }));
  const match = attempts.find((attempt) => attempt.checksum === storedHash);
  // On a mismatch, report the primary format so the manager sees what the
  // current row hashes to.
  const reported = match ?? attempts[0];

  return {
    status: match ? VERIFIED : CHECKSUM_MISMATCH,
    algorithm: 'SHA-256',
    format: reported.format,
    storedChecksum: stored,
    recomputedChecksum: reported.checksum,
    verifiedAt,
  };
}

/** Builds the read-only inspection view of a stored log. */
export function toLogInspection(
  log: InspectableLog,
  now: Date = new Date(),
): LogInspection {
  return {
    log: {
      id: log.id,
      transactionId: log.transactionId,
      kioskId: log.kioskId,
      meterVolume: log.meterVolume,
      recordedAt: log.recordedAt,
      createdAt: log.createdAt,
      operatorId: log.operatorId ?? null,
      reportedCash: log.reportedCash ?? null,
      expectedRevenue: log.expectedRevenue ?? null,
      variance: log.variance ?? null,
      isAnomaly: log.isAnomaly ?? null,
      ...(log.proofImageUrl !== undefined
        ? { proofImageUrl: log.proofImageUrl }
        : {}),
      ...(log.waterType !== undefined ? { waterType: log.waterType } : {}),
      ...(log.isSynced !== undefined ? { isSynced: log.isSynced } : {}),
      ...(log.isReadByManager !== undefined
        ? { isReadByManager: log.isReadByManager }
        : {}),
    },
    verification: verifyStoredChecksum(log, now),
  };
}
