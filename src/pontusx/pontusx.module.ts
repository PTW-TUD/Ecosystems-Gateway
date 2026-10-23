import { Module } from '@nestjs/common';
import { PontusxService } from './pontusx.service.js';
import { CredentialEventServiceModule } from '../credential-event-service/credential-event-service.module.js';

@Module({
  imports: [CredentialEventServiceModule],
  providers: [PontusxService],
  exports: [PontusxService],
})
export class PontusxModule {}
