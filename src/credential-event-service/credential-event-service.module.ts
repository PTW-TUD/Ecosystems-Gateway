import { Module } from '@nestjs/common';
import { CredentialEventServiceService } from './credential-event-service.service';
import { HttpModule } from '@nestjs/axios';
@Module({
  imports: [HttpModule],
  providers: [CredentialEventServiceService],
  exports: [CredentialEventServiceService],
})
export class CredentialEventServiceModule {}
