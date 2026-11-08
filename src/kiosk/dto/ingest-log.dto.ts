import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  IsOptional,
  IsBoolean,
  IsIn,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export const WATER_TYPES = ['COMMERCIAL', 'SUBSIDIZED'] as const;
export type WaterTypeDto = (typeof WATER_TYPES)[number];
export const READING_TYPES = ['CUMULATIVE_METER', 'DAILY_VOLUME'] as const;
export type ReadingTypeDto = (typeof READING_TYPES)[number];

/** Canonical operator identifier, e.g. OP-001 (three digits, as in the spec). */
export const OPERATOR_ID_PATTERN = /^OP-\d{3}$/;

/**
 * DTO for ingesting a daily log / meter-volume reading from a kiosk.
 *
 * Validated automatically by NestJS's global ValidationPipe.
 */
export class IngestLogDto {
  /** Unique transaction ID – used for idempotency checks. */
  @IsString()
  @IsNotEmpty({ message: 'transactionId is required' })
  transactionId!: string;

  /** ID of the kiosk that produced the reading (e.g. "KIOSK-001"). */
  @IsString()
  @IsNotEmpty({ message: 'kioskId is required' })
  kioskId!: string;

  /** Optional ID of the operator who collected/submitted the daily log (Story 05). */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString({ message: 'operatorId must be a string' })
  @Matches(OPERATOR_ID_PATTERN, {
    message: 'operatorId must look like OP-001',
  })
  operatorId?: string;

  /** Meter volume reading – must be a positive number. */
  @IsNumber({}, { message: 'meterVolume must be a number' })
  @IsPositive({ message: 'meterVolume must be positive' })
  meterVolume!: number;

  /** Optional reported cash collected during the shift/day. */
  @IsOptional()
  @IsNumber({}, { message: 'reportedCash must be a number' })
  @Min(0, { message: 'reportedCash must be non-negative' })
  reportedCash?: number;

  /** Daily volumes may decrease; cumulative meter readings must be monotonic. */
  @IsOptional()
  @IsIn(READING_TYPES, {
    message: 'readingType must be CUMULATIVE_METER or DAILY_VOLUME',
  })
  readingType?: ReadingTypeDto;

  /** Optional expected revenue calculated for the reading. */
  @IsOptional()
  @IsNumber({}, { message: 'expectedRevenue must be a number' })
  @Min(0, { message: 'expectedRevenue must be non-negative' })
  expectedRevenue?: number;

  /** Optional variance between reportedCash and expectedRevenue. */
  @IsOptional()
  @IsNumber({}, { message: 'variance must be a number' })
  variance?: number;

  /** Optional flag indicating whether this reading is a volume anomaly. */
  @IsOptional()
  @IsBoolean({ message: 'isAnomaly must be a boolean' })
  isAnomaly?: boolean;

  /** Optional URL/path to the physical meter/receipt photo proof (Story 05). */
  @IsOptional()
  @IsString({ message: 'proofImageUrl must be a string' })
  @MaxLength(512)
  proofImageUrl?: string;

  /** Optional water pricing tier: COMMERCIAL or SUBSIDIZED (Story 09). */
  @IsOptional()
  @IsIn(WATER_TYPES, {
    message: 'waterType must be COMMERCIAL or SUBSIDIZED',
  })
  waterType?: WaterTypeDto;

  /** ISO-8601 timestamp of when the reading was recorded on the kiosk. */
  @IsDateString(
    {},
    { message: 'recordedAt must be a valid ISO-8601 date string' },
  )
  @IsNotEmpty({ message: 'recordedAt is required' })
  recordedAt!: string;

  /** Optional SHA-256 checksum for data-integrity verification (Story 14-2). */
  @IsOptional()
  @IsString()
  checksum?: string;
}
