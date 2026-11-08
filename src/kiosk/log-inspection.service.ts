import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DEFAULT_LOG_PAGE_SIZE, ListLogsQueryDto } from './dto/list-logs.dto';
import {
  toLogInspection,
  type InspectableLog,
  type LogInspection,
} from './log-inspection';

export interface LogSummary {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: Date;
  createdAt: Date;
}

export interface LogPage {
  data: LogSummary[];
  /** Pass as `cursor` to fetch the next page; `null` on the last page. */
  nextCursor: string | null;
}

const summarySelect = {
  id: true,
  transactionId: true,
  kioskId: true,
  meterVolume: true,
  recordedAt: true,
  createdAt: true,
} as const;

/**
 * Read-only access to stored daily logs for Operation Managers.
 * Never writes: inspecting a log must not change the evidence.
 */
@Injectable()
export class LogInspectionService {
  constructor(private readonly prisma: PrismaService) {}

  async listLogs(query: ListLogsQueryDto): Promise<LogPage> {
    const limit = query.limit ?? DEFAULT_LOG_PAGE_SIZE;

    // Fetch one extra row to learn whether another page exists.
    const rows: LogSummary[] = await this.prisma.dailyLog.findMany({
      where: query.kioskId ? { kioskId: query.kioskId } : undefined,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: summarySelect,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return { data, nextCursor: hasMore ? data[data.length - 1].id : null };
  }

  /** Loads a log and re-verifies its checksum against the current DB values. */
  async inspectLog(id: string): Promise<LogInspection> {
    const log: InspectableLog | null = await this.prisma.dailyLog.findUnique({
      where: { id },
    });

    if (!log) {
      throw new NotFoundException(`Log "${id}" not found.`);
    }

    return toLogInspection(log);
  }
}
