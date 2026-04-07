import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { GrpcController } from './grpc.controller';
import { CredentialEventServiceModule } from './credential-event-service/credential-event-service.module';
import { PontusxModule } from './pontusx/pontusx.module';
import { XfscModule } from './xfsc/xfsc.module';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@nestjs-modules/ioredis';
import { GrpcGatewayController } from './grpc-gateway.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'single',
        url: `redis://${configService.get<string>('REDIS_ADDRESS', '127.0.0.1:6379')}`,
      }),
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
