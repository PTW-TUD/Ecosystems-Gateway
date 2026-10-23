import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import protoLoader from '@grpc/proto-loader';
import { runtimeProtos } from '../scripts/generate-runtime-proto.mjs';

// npm run proto:gen writes the runtime protos the gRPC server loads from src/_proto.

const ROOT = resolve(import.meta.dirname, '..');

describe('runtime proto', () => {
  const protos: { source: string; target: string; content: string }[] =
    runtimeProtos();

  it('is generated for every proto', () => {
    expect(protos.map(({ source }) => source)).toContain(
      'src/_proto/spp_v3.proto',
    );
  });

  it.each(protos.map((proto) => [proto.source, proto]))(
    'is current for %s',
    (_source, { target, content }) => {
      expect(existsSync(target)).toBe(true);
      // compared without line ending differences, which git may add on checkout
      expect(readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toBe(
        content.replace(/\r\n/g, '\n'),
      );
    },
  );

  it('loads with the options of the gRPC server and keeps the HTTP routes', () => {
    const definition = protoLoader.loadSync(
      resolve(ROOT, 'src/_proto_runtime/spp_v3.runtime.proto'),
      {
        keepCase: true,
        defaults: true,
        oneofs: true,
        includeDirs: [resolve(ROOT, 'node_modules/google-proto-files')],
      },
    );
    const service = definition[
      'eupg.ecosystemsgateway.v3.ecosystemsgateway'
    ] as protoLoader.ServiceDefinition;

    expect(Object.keys(service)).toHaveLength(9);
    expect(service.CreateOffering.path).toBe(
      '/eupg.ecosystemsgateway.v3.ecosystemsgateway/CreateOffering',
    );
    expect(service.CreateOffering.options['(google.api.http)']).toEqual({
      post: '/grpc/CreateOffering',
      body: '*',
    });
  });
});
