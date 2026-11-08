import { ConflictException } from '@nestjs/common';

// ───────────────────────────────────────────────────────────
//  Story 14-2 – Server-side conflict detection
//  Compares an incoming (possibly offline-cached) meter reading
//  with the readings already stored on the server for the same kiosk.
// ───────────────────────────────────────────────────────────

/** Error code returned to the client. Distinct from the duplicate-transactionId 409. */
export const STATE_CONFLICT = 'STATE_CONFLICT';

export type MeterConflictReason =
  /** Incoming reading is higher than a reading recorded at the same time or later. */
  | 'HIGHER_THAN_NEWER_READING'
  /** Incoming reading is lower than a reading recorded at the same time or earlier. */
  | 'LOWER_THAN_OLDER_READING';

export interface StoredReading {
  transactionId: string;
  meterVolume: number;
  recordedAt: Date;
}

export interface MeterConflict {
  reason: MeterConflictReason;
  conflictingRecord: StoredReading;
}

export interface IncomingReading {
  kioskId: string;
  meterVolume: number;
  recordedAt: Date;
}

const readingSelect = {
  transactionId: true,
  meterVolume: true,
  recordedAt: true,
} as const;

export interface MeterConflictPrisma {
  dailyLog: {
    findFirst: (args: any) => Promise<StoredReading | null>;
  };
}

/**
 * Detects whether an incoming meter reading conflicts with server state.
 *
 * `meterVolume` is a cumulative meter value, so for one kiosk it must never
 * decrease as `recordedAt` increases. The incoming reading must therefore fit
 * between its neighbours on the server:
 *
 *   older reading  ≤  incoming  ≤  newer reading
 *
 * A stored reading with the exact same `recordedAt` counts as both neighbours,
 * so it must have the same volume. Because every accepted reading passes this
 * check, the server history stays monotonic and only the nearest neighbour on
 * each side needs to be compared.
 *
 * @returns the first conflict found (newer state is checked first), or `null`.
 */
export async function findMeterConflict(
  prisma: MeterConflictPrisma,
  incoming: IncomingReading,
): Promise<MeterConflict | null> {
  const { kioskId, meterVolume, recordedAt } = incoming;

  // 1. Newer server state – the closest reading at or after the incoming time
  const newer = await prisma.dailyLog.findFirst({
    where: { kioskId, recordedAt: { gte: recordedAt } },
    orderBy: { recordedAt: 'asc' },
    select: readingSelect,
  });

  if (newer && newer.meterVolume < meterVolume) {
    return { reason: 'HIGHER_THAN_NEWER_READING', conflictingRecord: newer };
  }

  // 2. Older server state – the closest reading at or before the incoming time
  const older = await prisma.dailyLog.findFirst({
    where: { kioskId, recordedAt: { lte: recordedAt } },
    orderBy: { recordedAt: 'desc' },
    select: readingSelect,
  });

  if (older && older.meterVolume > meterVolume) {
    return { reason: 'LOWER_THAN_OLDER_READING', conflictingRecord: older };
  }

  return null;
}

/**
 * Builds the `409 Conflict` response for a detected state conflict.
 *
 * Body shape: `{ statusCode, ack: false, error: "STATE_CONFLICT", reason, message, conflictingRecord }`
 */
export function toStateConflictException(
  incoming: IncomingReading,
  conflict: MeterConflict,
): ConflictException {
  const { conflictingRecord: existing } = conflict;
  const relation =
    conflict.reason === 'HIGHER_THAN_NEWER_READING'
      ? 'is higher than newer'
      : 'is lower than older';

  return new ConflictException({
    statusCode: 409,
    ack: false,
    error: STATE_CONFLICT,
    reason: conflict.reason,
    message:
      `Meter reading ${incoming.meterVolume} at ${incoming.recordedAt.toISOString()} ` +
      `${relation} server reading ${existing.meterVolume} at ${existing.recordedAt.toISOString()} ` +
      `(txn: ${existing.transactionId}) for kiosk "${incoming.kioskId}".`,
    conflictingRecord: existing,
  });
}
