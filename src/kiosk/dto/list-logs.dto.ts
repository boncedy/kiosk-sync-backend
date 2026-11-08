import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const DEFAULT_LOG_PAGE_SIZE = 20;
export const MAX_LOG_PAGE_SIZE = 100;

/** Query for `GET /api/kiosk/logs` – newest first, cursor-paginated. */
export class ListLogsQueryDto {
  /** Only return logs from this kiosk. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kioskId?: string;

  /** `nextCursor` from the previous page (a log ID). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(MAX_LOG_PAGE_SIZE, {
    message: `limit must not exceed ${MAX_LOG_PAGE_SIZE}`,
  })
  limit?: number;
}
