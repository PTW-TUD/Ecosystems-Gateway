import {
  Controller,
  Get,
  Post,
  Logger,
  HttpStatus,
  HttpException,
  Body,
  Param,
} from '@nestjs/common';
import {
  loadGrpcClient,
  loadGrpcServiceDefinition,
} from './grpc-client.loader';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('grpc')
@Controller('grpc')
export class GrpcGatewayController {
  private readonly logger: Logger;
  private grpcClient: any;
  private grpcDefinitions: any;

  constructor(private readonly configService: ConfigService) {
    this.logger = new Logger(GrpcGatewayController.name);
    this.grpcClient = loadGrpcClient(
      './_proto_runtime/spp_v2.runtime.proto',
      'eupg.serviceofferingpublisher',
      'serviceofferingPublisher',
      configService.get('GRPC_BIND', '0.0.0.0:5002'), // TODO: Fix default values
    );

    this.grpcDefinitions = loadGrpcServiceDefinition(
      './_proto_runtime/spp_v2.runtime.proto',
      'eupg.serviceofferingpublisher',
      'serviceofferingPublisher',
    );

    this.logger.log(
      `Loaded ${Object.keys(this.grpcDefinitions['serviceofferingPublisher'].service).length} grpc services`,
    );
  }

  @Get('list')
  @ApiOperation({ summary: 'List all gRPC methods' })
  @ApiResponse({
    status: 200,
    description: 'List of available gRPC methods and payload schemas',
  })
  listMethods() {
    return Object.keys(
      this.grpcDefinitions['serviceofferingPublisher'].service,
    );
  }

  @Post(':method')
  @ApiOperation({ summary: 'Invoke gRPC method dynamically' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Successful gRPC call',
    schema: { type: 'object', additionalProperties: true },
  })
  async handleGrpcCall(@Param('method') methodName: string, @Body() body: any) {
    if (!this.grpcDefinitions['serviceofferingPublisher'].service[methodName]) {
      throw new HttpException(
        `gRPC method ${methodName} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    try {
      return await this.callGrpcMethod(methodName, body);
    } catch (error) {
      this.logger.error(`Error calling gRPC method ${methodName}:`, error);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private callGrpcMethod(method: string, params: any) {
    return new Promise((resolve, reject) => {
      if (typeof this.grpcClient[method] !== 'function') {
        return reject(
          new Error(`Method ${method} does not exist on the gRPC service`),
        );
      }
      this.grpcClient[method](params, (error, response) => {
        if (error) {
          return reject(error.details);
        }
        return resolve(response);
      });
    });
  }
}
