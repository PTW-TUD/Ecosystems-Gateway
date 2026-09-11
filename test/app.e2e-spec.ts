import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MicroserviceOptions,
  RpcException,
  Transport,
} from '@nestjs/microservices';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import { status } from '@grpc/grpc-js';
import { ReflectionService } from '@grpc/reflection';
import { readFileSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import * as request from 'supertest';
import * as swaggerUi from 'swagger-ui-express';
import { AppModule } from '../src/app.module';
import { GrpcGatewayController } from '../src/grpc-gateway.controller';
import { PontusxService } from '../src/pontusx/pontusx.service';
import { XfscService } from '../src/xfsc/xfsc.service';

describe('HTTP and gRPC gateway (e2e)', () => {
  let app: INestApplication;
  const getOffering = jest.fn();

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not allocate a local gRPC port'));
          return;
        }
        server.close((error) =>
          error ? reject(error) : resolve(address.port),
        );
      });
    });
    const grpcBind = `127.0.0.1:${port}`;
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, fallback?: unknown) =>
          key === 'GRPC_BIND' ? grpcBind : fallback,
      })
      // Keep real Nest modules and transports, with no Redis or ecosystem calls.
      .overrideProvider(getRedisConnectionToken())
      .useValue({ quit: jest.fn().mockResolvedValue('OK') })
      .overrideProvider(PontusxService)
      .useValue({ getOffering })
      .overrideProvider(XfscService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        url: grpcBind,
        package: 'eupg.ecosystemsgateway',
        protoPath: join(
          __dirname,
          '../src/_proto_runtime/spp_v2.runtime.proto',
        ),
        loader: {
          keepCase: true,
          longs: String,
          defaults: true,
          oneofs: true,
          includeDirs: [join(__dirname, '../node_modules/google-proto-files')],
        },
        onLoadPackageDefinition: (pkg, server) => {
          new ReflectionService(pkg).addToServer(server);
        },
      },
    });
    const openapiDoc = JSON.parse(
      readFileSync(
        join(__dirname, '../src/openapi/spp_v2.swagger.json'),
        'utf8',
      ),
    );
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
    await app.startAllMicroservices();
    await app.init();
  });

  beforeEach(() => {
    getOffering.mockReset();
  });

  afterAll(async () => {
    if (app) {
      // The gateway currently owns a client without a shutdown hook.
      app.get(GrpcGatewayController)['grpcClient'].close();
      await app.close();
    }
  });

  it('lists methods loaded from the runtime proto', async () => {
    const response = await request(app.getHttpServer())
      .get('/grpc/list')
      .expect(200);
    expect(response.body).toHaveLength(9);
    expect(response.body).toEqual(
      expect.arrayContaining([
        'GetOffering',
        'CreateOffering',
        'RunComputeToDataJob',
      ]),
    );
  });

  it('serves Swagger UI', async () => {
    await request(app.getHttpServer())
      .get('/docs/')
      .expect(200)
      .expect('Content-Type', /html/)
      .expect(/swagger-ui/);
  });

  it('forwards HTTP requests through gRPC and serializes the response', async () => {
    const offering = { id: 'did:op:test', metadata: { name: 'Test offering' } };
    getOffering.mockResolvedValue(offering);
    const response = await request(app.getHttpServer())
      .post('/grpc/GetOffering')
      .send({ offerings: [{ pontusxOffering: { did: offering.id } }] })
      .expect(201);
    expect(getOffering).toHaveBeenCalledWith(offering.id);
    expect(response.body.offerings).toEqual([JSON.stringify(offering)]);
  });

  it('maps gRPC errors to HTTP status codes', async () => {
    getOffering.mockRejectedValue(
      new RpcException({
        code: status.NOT_FOUND,
        message: 'Offering not found',
      }),
    );
    const response = await request(app.getHttpServer())
      .post('/grpc/GetOffering')
      .send({ offerings: [{ pontusxOffering: { did: 'did:op:missing' } }] })
      .expect(404);
    expect(response.body.grpc).toEqual({
      code: status.NOT_FOUND,
      name: 'NOT_FOUND',
    });
    expect(response.body.message).toBe('Offering not found');
    expect(response.body).not.toHaveProperty('details');
  });

  it('rejects unknown methods', async () => {
    await request(app.getHttpServer())
      .post('/grpc/DoesNotExist')
      .send({})
      .expect(404);
    expect(getOffering).not.toHaveBeenCalled();
  });

  it('preserves structured upstream validation errors through HTTP and gRPC', async () => {
    const errors = { services: 'Less than 1 value on schema1:services' };
    getOffering.mockRejectedValue({
      response: { status: 400, data: { errors } },
    });
    const response = await request(app.getHttpServer())
      .post('/grpc/GetOffering')
      .send({ offerings: [{ pontusxOffering: { did: 'did:op:test' } }] })
      .expect(400);
    expect(response.body.grpc.code).toBe(status.INVALID_ARGUMENT);
    expect(response.body.message).toBe(
      `services: ${errors.services}`,
    );
    expect(response.body.details).toEqual({ errors });
  });
});
