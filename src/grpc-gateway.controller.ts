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
import { status as GrpcStatusCode } from '@grpc/grpc-js';
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
      'eupg.ecosystemsgateway',
      'ecosystemsgateway',
      configService.get('GRPC_BIND', '0.0.0.0:5002'), // TODO: Fix default values
    );

    this.grpcDefinitions = loadGrpcServiceDefinition(
      './_proto_runtime/spp_v2.runtime.proto',
      'eupg.ecosystemsgateway',
      'ecosystemsgateway',
    );

    this.logger.log(
      `Loaded ${Object.keys(this.grpcDefinitions['ecosystemsgateway'].service).length} grpc services`,
    );
  }

  @Get('list')
  @ApiOperation({ summary: 'List all gRPC methods' })
  @ApiResponse({
    status: 200,
    description: 'List of available gRPC methods and payload schemas',
  })
  listMethods() {
    return Object.keys(this.grpcDefinitions['ecosystemsgateway'].service);
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
    if (!this.grpcDefinitions['ecosystemsgateway'].service[methodName]) {
      throw new HttpException(
        `gRPC method ${methodName} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    try {
      return await this.callGrpcMethod(methodName, body);
    } catch (error) {
      const grpcCode: number | undefined =
        typeof error?.code === 'number' ? error.code : undefined;

      const httpStatus = this.grpcCodeToHttpStatus(grpcCode);
      const grpcCodeName =
        grpcCode != undefined
          ? ((GrpcStatusCode as any)[grpcCode] ?? 'UNKNOWN')
          : 'UNKNOWN';
      this.logger.error(`Error calling gRPC method ${methodName}:`, error);
      throw new HttpException(
        {
          message: error.message,
          grpc: {
            code: grpcCode ?? null,
            name: grpcCodeName,
          },
        },
        httpStatus,
      );
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
          return reject(error);
        }
        return resolve(response);
      });
    });
  }

  private grpcCodeToHttpStatus(code?: number): number {
    switch (code) {
      case GrpcStatusCode.OK:
        return HttpStatus.OK;
      case GrpcStatusCode.INVALID_ARGUMENT:
        return HttpStatus.BAD_REQUEST;
      case GrpcStatusCode.NOT_FOUND:
        return HttpStatus.NOT_FOUND;
      case GrpcStatusCode.ALREADY_EXISTS:
        return HttpStatus.CONFLICT;
      case GrpcStatusCode.PERMISSION_DENIED:
        return HttpStatus.FORBIDDEN;
      case GrpcStatusCode.UNAUTHENTICATED:
        return HttpStatus.UNAUTHORIZED;
      case GrpcStatusCode.RESOURCE_EXHAUSTED:
        return HttpStatus.TOO_MANY_REQUESTS;
      case GrpcStatusCode.FAILED_PRECONDITION:
        return HttpStatus.PRECONDITION_FAILED;
      case GrpcStatusCode.OUT_OF_RANGE:
        return HttpStatus.BAD_REQUEST;
      case GrpcStatusCode.UNIMPLEMENTED:
        return HttpStatus.NOT_IMPLEMENTED;
      case GrpcStatusCode.UNAVAILABLE:
        return HttpStatus.SERVICE_UNAVAILABLE;
      case GrpcStatusCode.DEADLINE_EXCEEDED:
        return HttpStatus.GATEWAY_TIMEOUT;
      case GrpcStatusCode.CANCELLED:
        return 499; // NGINX convention “Client Closed Request”
      case GrpcStatusCode.INTERNAL:
      default:
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }
}
