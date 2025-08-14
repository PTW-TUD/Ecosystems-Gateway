import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { resolve, join } from 'path';
import { ConfigService } from '@nestjs/config';
import { Logger, LogLevel } from '@nestjs/common';
//import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync, readFileSync } from 'fs';
import * as swaggerUi from 'swagger-ui-express';
import { ReflectionService } from '@grpc/reflection';

// ---- helper ----
function toBool(input: unknown, defaultVal = false): boolean {
  if (input == null) return defaultVal;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

async function bootstrap() {
  // log level needs to be set on app creation
  const logLevelsEnv = process.env.NESTJS_LOG_LEVELS || 'log';
  const loggerLevels = logLevelsEnv.split(',') as LogLevel[];
  const app = await NestFactory.create(AppModule, { logger: loggerLevels });
  const LOGGER = new Logger('main');
  const configService = app.get<ConfigService>(ConfigService);

  // ===========================================================
  // gRPC MICROSERVER
  // ===========================================================
  const ENABLE_GRPC_SERVER = toBool(
    process.env.ENABLE_GRPC_SERVER ?? configService.get('ENABLE_GRPC_SERVER'),
    true,
  );

  if (ENABLE_GRPC_SERVER) {
    const GRPC_BIND = configService.get<string>('GRPC_BIND', '0.0.0.0:5002');
    const ENABLE_GRPC_REFLECTION = toBool(
      process.env.ENABLE_GRPC_REFLECTION ??
        configService.get('ENABLE_GRPC_REFLECTION'),
      false,
    );

    const protoPath = join(__dirname, './_proto_runtime/spp_v2.runtime.proto');
    if (!existsSync(protoPath)) {
      LOGGER.error(`Proto not found at ${protoPath}.`);
      process.exit(1);
    }

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        url: GRPC_BIND,
        package: 'eupg.serviceofferingpublisher',
        protoPath: protoPath,
        loader: {
          keepCase: true,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
          includeDirs: [
            join(__dirname, './_proto'),
            resolve(__dirname, '..', 'node_modules', 'google-proto-files'),
          ],
        },
        onLoadPackageDefinition: ENABLE_GRPC_REFLECTION
          ? (pkg, server) => {
              new ReflectionService(pkg).addToServer(server);
            }
          : undefined,
      },
    });

    await app.startAllMicroservices();
    LOGGER.log(
      `gRPC Server listening on '${GRPC_BIND}' and ${ENABLE_GRPC_REFLECTION ? 'enabled' : 'disabled'} gRPC Reflection`,
    );
  } else {
    LOGGER.log('gRPC Server disabled via ENABLE_GRPC_SERVER=false');
  }

  // ===========================================================
  // Swagger UI (from proto-generated spec)
  // ===========================================================
  const openapiPathCandidates = [
    // when running from compiled dist/
    resolve(__dirname, '..', 'openapi', 'spp_v2.swagger.json'),
    // when running directly from project root
    resolve(process.cwd(), 'openapi', 'spp_v2.swagger.json'),
  ];
  let openapiDoc: any | null = null;
  for (const p of openapiPathCandidates) {
    if (existsSync(p)) {
      openapiDoc = JSON.parse(readFileSync(p, 'utf-8'));
      LOGGER.log(`Loaded OpenAPI doc from ${p}`);
      break;
    }
  }

  if (openapiDoc) {
    app
      .getHttpAdapter()
      .getInstance()
      .get('/openapi.json', (_req, res) => {
        res.json(openapiDoc);
      });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
    LOGGER.log('Swagger UI mounted at /docs');
  } else {
    LOGGER.warn(
      'No OpenAPI doc found in ./openapi/. Generate spp_v2.swagger.json first.',
    );
  }

  await app.init();

  // ===========================================================
  // HTTP Gateway listen (env-gated)
  // ===========================================================
  const ENABLE_GRPC_GATEWAY = toBool(
    process.env.ENABLE_GRPC_SERVER ?? configService.get('ENABLE_GRPC_GATEWAY'),
    false,
  );

  if (ENABLE_GRPC_GATEWAY) {
    const GRPC_GATEWAY_BIND = configService.get<string>(
      'GRPC_GATEWAY_BIND',
      '0.0.0.0:3000',
    );
    const [host, portStr] = GRPC_GATEWAY_BIND.includes(':')
      ? GRPC_GATEWAY_BIND.split(':', 2)
      : ['0.0.0.0', GRPC_GATEWAY_BIND];
    const port = Number(portStr);
    if (Number.isNaN(port)) {
      LOGGER.error(
        `Invalid GRPC_GATEWAY_BIND="${GRPC_GATEWAY_BIND}". Use "host:port", e.g. 0,0,0,0:3000`,
      );
      process.exit(1);
    }

    await app.listen(port, host);
    const url = await app.getUrl();
    LOGGER.log(`HTTP gRPC-Gateway listening on: ${url}`);
    LOGGER.log(`Docs: ${url}/docs`);
  } else {
    LOGGER.log('HTTP gRPC-Gateway disabled via ENABLE_GRPC_GATEWAY=false');
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
