import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { catchError, firstValueFrom } from 'rxjs';
import {
  ComplianceCloudEventDTO,
  defaultComplianceCloudEventDTO,
} from './event-dto.js';
import { formatErrorMessage } from '../grpc-error.util.js';
import { redactForLog } from '../logging.js';

@Injectable()
export class CredentialEventServiceService implements OnModuleInit {
  private readonly logger = new Logger(CredentialEventServiceService.name);
  private cesUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.cesUrl = this.configService.get('CES_URL');
  }

  async publish(source: string, vc: any) {
    const payload: ComplianceCloudEventDTO = {
      ...defaultComplianceCloudEventDTO,
      source: source,
      subject: null, // FIXME: clarifiy what this field should be
      time: new Date().toISOString(),
      data: vc,
    };

    this.logger.debug(`Posting event of ${source} to ${this.cesUrl}`);
    this.logger.verbose(redactForLog(payload));

    const { headers } = await firstValueFrom(
      this.httpService.post(this.cesUrl, payload).pipe(
        catchError((err: AxiosError) => {
          // TODO: proper error handling
          this.logger.error(
            `Publishing to the Credential Event Service failed: ${formatErrorMessage(err)}`,
          );
          throw 'Failed to push data to the Credential Event Service';
        }),
      ),
    );
    this.logger.debug(
      `Credential Event Service created the event at ${headers['location']}`,
    );
    return headers['location'];
  }
}
