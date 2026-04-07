import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join, resolve } from 'path';

export function loadGrpcServiceDefinition(
  protoPath: string,
  packageName: string,
  serviceName: string,
) {
  const packageDefinition = protoLoader.loadSync(join(__dirname, protoPath), {
    keepCase: true,
    longs: String,
    defaults: true,
    oneofs: true,
    includeDirs: [
      join(__dirname, './_proto'),
      resolve(__dirname, '..', 'node_modules', 'google-proto-files'),
    ],
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
  const grpcPackage = getGrpcPackage(protoDescriptor, packageName);
  if (!grpcPackage[serviceName]) {
    throw new Error(
      `gRPC service '${serviceName}' not found in package '${packageName}'`,
    );
  }

  return grpcPackage;
}

function getGrpcPackage(protoDescriptor: any, packageName: string): any {
  const keys = packageName.split('.');
  let current = protoDescriptor;

  for (const key of keys) {
    if (!current[key]) {
      throw new Error(`gRPC package path '${packageName}' not found.`);
    }
    current = current[key];
  }

  return current;
}

export function loadGrpcClient(
  protoPath: string,
  packageName: string,
  serviceName: string,
  url: string,
) {
  const packageDefinition = protoLoader.loadSync(join(__dirname, protoPath), {
    keepCase: true,
    longs: String,
    defaults: true,
    oneofs: true,
    includeDirs: [
      join(__dirname, './_proto'),
      resolve(__dirname, '..', 'node_modules', 'google-proto-files'),
    ],
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
  const grpcPackage = getGrpcPackage(protoDescriptor, packageName);
  return new grpcPackage[serviceName](url, grpc.credentials.createInsecure());
}
