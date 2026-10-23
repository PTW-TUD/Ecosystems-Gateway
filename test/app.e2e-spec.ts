import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';
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
import request from 'supertest';
import swaggerUi from 'swagger-ui-express';
import { AppModule } from '../src/app.module.js';
import { GrpcGatewayController } from '../src/grpc-gateway.controller.js';
import { PontusxService } from '../src/pontusx/pontusx.service.js';
import { XfscService } from '../src/xfsc/xfsc.service.js';

describe('HTTP and gRPC gateway (e2e)', () => {
  let app: INestApplication;
  const getOffering = vi.fn();
  const queryOfferings = vi.fn();
  const requestComputeToData = vi.fn();

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
      .useValue({ quit: vi.fn().mockResolvedValue('OK') })
      .overrideProvider(PontusxService)
      .useValue({ getOffering, queryOfferings, requestComputeToData })
      .overrideProvider(XfscService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        url: grpcBind,
        package: 'eupg.ecosystemsgateway.v3',
        protoPath: join(
          import.meta.dirname,
          '../src/_proto_runtime/spp_v3.runtime.proto',
        ),
        loader: {
          keepCase: true,
          longs: String,
          defaults: true,
          oneofs: true,
          includeDirs: [
            join(import.meta.dirname, '../node_modules/google-proto-files'),
          ],
        },
        onLoadPackageDefinition: (pkg, server) => {
          new ReflectionService(pkg).addToServer(server);
        },
      },
    });
    const openapiDoc = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../src/openapi/spp_v3.swagger.json'),
        'utf8',
      ),
    );
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
    await app.startAllMicroservices();
    await app.init();
  });

  beforeEach(() => {
    getOffering.mockReset();
    queryOfferings.mockReset();
    requestComputeToData.mockReset();
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
    const offering = {
      id: 'did:ope:test',
      metadata: { name: 'Test offering' },
    };
    getOffering.mockResolvedValue(offering);
    const response = await request(app.getHttpServer())
      .post('/grpc/GetOffering')
      .send({ offerings: [{ pontusxOffering: { did: offering.id } }] })
      .expect(201);
    expect(getOffering).toHaveBeenCalledWith(offering.id);
    expect(response.body.offerings).toEqual([JSON.stringify(offering)]);
  });

  it('answers QueryOfferings', async () => {
    queryOfferings.mockResolvedValue([[{ id: 'did:ope:1' }], 1]);
    const response = await request(app.getHttpServer())
      .post('/grpc/QueryOfferings')
      .send({ query: { pontusxQuery: { name: 'data', page: 1 } } })
      .expect(201);
    expect(response.body).toEqual({
      offerings: [JSON.stringify({ id: 'did:ope:1' })],
      total: 1,
    });
  });

  it('answers a QueryOfferings without matches with an empty list', async () => {
    queryOfferings.mockResolvedValue([[], 0]);
    const response = await request(app.getHttpServer())
      .post('/grpc/QueryOfferings')
      .send({ query: { pontusxQuery: { name: 'nothing' } } })
      .expect(201);
    expect(response.body).toEqual({ offerings: [], total: 0 });
  });

  it('passes the compute options of a job to the service', async () => {
    requestComputeToData.mockResolvedValue(['0xenv-job']);
    const response = await request(app.getHttpServer())
      .post('/grpc/RunComputeToDataJob')
      .send({
        did: 'did:ope:data',
        algorithm: 'did:ope:algo',
        algorithmParameters: { threshold: '0.5' },
        computeEnv: 'env-1',
        resources: [{ id: 'cpu', amount: 2 }],
        free: true,
      })
      .expect(201);
    expect(response.body).toEqual({ jobId: ['0xenv-job'] });
    expect(requestComputeToData).toHaveBeenCalledWith(
      expect.objectContaining({
        did: 'did:ope:data',
        algorithm: 'did:ope:algo',
        userdata: {},
        algorithmParameters: { threshold: '0.5' },
        computeEnv: 'env-1',
        resources: [{ id: 'cpu', amount: 2 }],
        free: true,
      }),
    );
    // unset optional fields are left out
    expect(requestComputeToData.mock.calls[0][0]).not.toHaveProperty(
      'maxJobDuration',
    );
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
      .send({ offerings: [{ pontusxOffering: { did: 'did:ope:missing' } }] })
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
      .send({ offerings: [{ pontusxOffering: { did: 'did:ope:test' } }] })
      .expect(400);
    expect(response.body.grpc.code).toBe(status.INVALID_ARGUMENT);
    expect(response.body.message).toBe(`services: ${errors.services}`);
    expect(response.body.details).toEqual({ errors });
  });
});
