import { Module } from '@nestjs/common';
import { XfscService } from './xfsc.service.js';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [HttpModule],
  providers: [XfscService],
  exports: [XfscService],
})
export class XfscModule {}
