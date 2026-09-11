import { RpcException } from '@nestjs/microservices';
import { Metadata, status as GrpcStatusCode } from '@grpc/grpc-js';
import { inspect } from 'node:util';

export type GrpcErrorObject = {
  code?: number; // gRPC status code (from @grpc/grpc-js status enum)
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
export function extractRpcError(
  e: RpcException,
): Required<Pick<GrpcErrorObject, 'message'>> & GrpcErrorObject {
  const payload = typeof e.getError === 'function' ? e.getError() : undefined;

  if (typeof payload === 'string') {
    return { message: formatErrorMessage(payload) };
  }
  if (isGrpcErrorObject(payload)) {
    return {
      code:
        typeof (payload as any).code === 'number'
          ? (payload as any).code
          : undefined,
      message: formatErrorMessage(payload),
      details:
        payload.details == null
          ? undefined
          : stringifyErrorValue(payload.details),
      metadata: (payload as any).metadata as any,
    };
  }

  return { message: 'Internal error' };
}

export type MapToRpcExceptionArgs = {
  service: string; // e.g. "pontusx" / "grpc.controller"
  where: string; // e.g. method name
  defaultCode?: number; // fallback, default INTERNAL
};

/**
 * Map any error (Axios/HTTP/Nest/JS) into a RpcException with:
 * - gRPC status code
 * - message
 * - optional details (JSON for HTTP response bodies)
 * - metadata (x-service, x-where)
 */
export function mapToRpcException(
  err: any,
  ctx: MapToRpcExceptionArgs,
): RpcException {
  const defaultCode = ctx.defaultCode ?? GrpcStatusCode.INTERNAL;

  // Axios-ish: err.response.status / err.response.data
  const httpStatus: number | undefined =
    (typeof err?.response?.status === 'number'
      ? err.response.status
      : undefined) ??
    (typeof err?.status === 'number' ? err.status : undefined);

  const message = formatErrorMessage(err);

  // Prefer structured response body as "details"
  const details =
    err?.response?.data != null
      ? stringifyErrorValue(err.response.data)
      : err?.details == null
        ? undefined
        : stringifyErrorValue(err.details);

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

  const rpcException = new RpcException({ code, message, details, metadata });
  if (typeof err?.stack === 'string') {
    rpcException.stack = err.stack.replace(
      /^[^\r\n]*/,
      `${err.name || 'Error'}: ${message}`,
    );
  }

  return rpcException;
}

/** Human-readable summary; structured details remain separate. */
export function formatErrorMessage(err: any): string {
  if (isRpcException(err)) return formatErrorMessage(err.getError());
  const value =
    (typeof err?.code === 'number' &&
    typeof err?.details === 'string' &&
    typeof err?.message === 'string' &&
    err.message.startsWith(`${err.code} ${GrpcStatusCode[err.code]}: `)
      ? err.details
      : undefined) ??
    err?.response?.data?.message ??
    err?.response?.data?.errors ??
    err?.message ??
    err?.details ??
    err;
  return value == null ? 'Internal error' : summarizeErrorValue(value);
}

/** Decode JSON details when available without changing ordinary text errors. */
export function extractErrorDetails(err: any): unknown {
  const value = err?.response?.data ?? err?.details;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value != null && typeof value === 'object' ? value : undefined;
}

function summarizeErrorValue(value: unknown): string {
  if (typeof value === 'string') {
    // Accept complete JSON or a contextual message ending in valid JSON.
    const match = value.match(/^(.*?:\s*)([\[{][\s\S]*)$/);
    const prefix = match?.[1] ?? '';
    const candidate = match?.[2] ?? value;
    try {
      const parsed = JSON.parse(value);
      if (parsed != null && typeof parsed === 'object')
        return summarizeErrorValue(parsed);
    } catch {
      /* Plain text, or JSON with a contextual prefix. */
    }
    if (prefix) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed != null && typeof parsed === 'object')
          return prefix + summarizeErrorValue(parsed);
      } catch {
        /* Preserve unrecognized messages verbatim. */
      }
    }
    return value;
  }

  const ancestors = new Set<object>();
  const parts: string[] = [];
  const visit = (entry: unknown, path: string, depth: number) => {
    if (parts.length >= 50) return;
    if (entry !== null && typeof entry === 'object') {
      if (ancestors.has(entry) || depth >= 20) {
        parts.push(
          `${path || 'error'}: ${ancestors.has(entry) ? '[Circular]' : '[Nested details]'}`,
        );
        return;
      }
      ancestors.add(entry);
      const entries = Object.entries(entry);
      if (!entries.length)
        parts.push(`${path || 'error'}: ${Array.isArray(entry) ? '[]' : '{}'}`);
      for (const [key, child] of entries) {
        const wrapper =
          !path &&
          entries.length === 1 &&
          ['errors', 'error', 'message'].includes(key);
        const childPath = wrapper
          ? ''
          : Array.isArray(entry)
            ? child !== null && typeof child === 'object'
              ? `${path}[${key}]`
              : path
            : path
              ? `${path}.${key}`
              : key;
        visit(child, childPath, depth + 1);
        if (parts.length >= 50) break;
      }
      ancestors.delete(entry);
    } else {
      parts.push(`${path ? `${path}: ` : ''}${String(entry)}`);
    }
  };
  visit(value, '', 0);
  const summary = parts.join('; ') + (parts.length >= 50 ? '; …' : '');
  return summary.length > 8000 ? summary.slice(0, 8000) + '…' : summary;
}

function stringifyErrorValue(v: unknown): string {
  if (typeof v === 'string') return v;
  let text: string;
  try {
    text = JSON.stringify(v, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    // Circular objects must not make the error handler itself throw.
    text = inspect(v, { depth: null, customInspect: false, getters: false });
  }
  text ??= 'Internal error';
  return text.length > 8000 ? text.slice(0, 8000) + '…' : text;
}
