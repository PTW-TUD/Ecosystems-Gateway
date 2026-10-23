import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { GrpcController } from './grpc.controller.js';
import { CredentialEventServiceModule } from './credential-event-service/credential-event-service.module.js';
import { PontusxModule } from './pontusx/pontusx.module.js';
import { XfscModule } from './xfsc/xfsc.module.js';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@nestjs-modules/ioredis';
import { GrpcGatewayController } from './grpc-gateway.controller.js';
import { logRedisConnection } from './redis-logging.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const address = configService.get<string>(
          'REDIS_ADDRESS',
          '127.0.0.1:6379',
        );
        return {
          type: 'single',
          url: `redis://${address}`,
          onClientReady: (client) => logRedisConnection(client, address),
        };
      },
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    CredentialEventServiceModule,
    PontusxModule,
    XfscModule,
  ],
  controllers: [GrpcController, GrpcGatewayController],
})
export class AppModule {}
