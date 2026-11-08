import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { ImgbbService } from './imgbb.service';
import { LogInspectionController } from './log-inspection.controller';
import { LogInspectionService } from './log-inspection.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [KioskController, LogInspectionController],
  providers: [KioskService, ImgbbService, LogInspectionService, PrismaService]
})
export class KioskModule {}
