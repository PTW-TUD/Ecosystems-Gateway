import { RpcException } from '@nestjs/microservices';
import { Metadata, status as GrpcStatusCode } from '@grpc/grpc-js';

export type GrpcErrorObject = {
  code?: number;                   // gRPC status code (from @grpc/grpc-js status enum)
  message?: string;
  details?: string;
  metadata?: Metadata;
};

export function isRpcException(err: unknown): err is RpcException {
  return err instanceof RpcException;
}

export function isGrpcErrorObject(v: unknown): v is GrpcErrorObject {
  return !!v && typeof v === 'object';
}

/** Normalize RpcException#getError() into a consistent shape */
export function extractRpcError(e: RpcException): Required<Pick<GrpcErrorObject, 'message'>> & GrpcErrorObject {
  const payload = typeof e.getError === 'function' ? e.getError() : undefined;

  if (typeof payload === 'string') {
    return { message: payload };
  }
  if (isGrpcErrorObject(payload)) {
    return {
      code: typeof (payload as any).code === 'number' ? (payload as any).code : undefined,
      message:
        typeof (payload as any).message === 'string'
          ? (payload as any).message
          : 'Internal error',
      details:
        typeof (payload as any).details === 'string'
          ? (payload as any).details
          : undefined,
      metadata: (payload as any).metadata as any,
    };
  }

  return { message: 'Internal error' };
}


export type MapToRpcExceptionArgs = {
  service: string;          // e.g. "pontusx" / "grpc.controller"
  where: string;            // e.g. method name
  defaultCode?: number;     // fallback, default INTERNAL
};

/**
 * Map any error (Axios/HTTP/Nest/JS) into a RpcException with:
 * - gRPC status code
 * - message
 * - optional details (JSON for HTTP response bodies)
 * - metadata (x-service, x-where)
 */
export function mapToRpcException(err: any, ctx: MapToRpcExceptionArgs): RpcException {
  const defaultCode = ctx.defaultCode ?? GrpcStatusCode.INTERNAL;

  // Axios-ish: err.response.status / err.response.data
  const httpStatus: number | undefined =
    (typeof err?.response?.status === 'number' ? err.response.status : undefined) ??
    (typeof err?.status === 'number' ? err.status : undefined);

  const rawMessage =
    err?.response?.data?.message ??
    err?.message ??
    (typeof err === 'string' ? err : undefined) ??
    'Internal error';

  const message = String(rawMessage);

  // Prefer structured response body as "details"
  const details =
    err?.response?.data != null ? safeStringify(err.response.data) : err?.details;

  // Map to gRPC status codes
  let code = defaultCode;
  if (httpStatus === 400 || /invalid|validation/i.test(message)) {
    code = GrpcStatusCode.INVALID_ARGUMENT;
  } else if (httpStatus === 401) {
    code = GrpcStatusCode.UNAUTHENTICATED;
  } else if (httpStatus === 403) {
    code = GrpcStatusCode.PERMISSION_DENIED;
  } else if (httpStatus === 404 || /not\s*found/i.test(message)) {
    code = GrpcStatusCode.NOT_FOUND;
  } else if (httpStatus === 409 || /already exists|conflict/i.test(message)) {
    code = GrpcStatusCode.ALREADY_EXISTS;
  } else if (httpStatus === 429) {
    code = GrpcStatusCode.RESOURCE_EXHAUSTED;
  } else if (httpStatus === 408 || /timeout|deadline/i.test(message)) {
    code = GrpcStatusCode.DEADLINE_EXCEEDED;
  } else if (err?.code === 'ETIMEDOUT') {
    code = GrpcStatusCode.DEADLINE_EXCEEDED;
  } else if (httpStatus != null && httpStatus >= 500) {
    code = GrpcStatusCode.INTERNAL;
  }

  const metadata = new Metadata();
  metadata.set('x-service', ctx.service);
  metadata.set('x-where', ctx.where);

  return new RpcException({ code, message, details, metadata });
}

function safeStringify(v: unknown): string | undefined {
  try {
    const s = JSON.stringify(v);
    return s.length > 8000 ? s.slice(0, 8000) + '…' : s;
  } catch {
    return undefined;
  }
}
