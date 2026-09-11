import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  extractRpcError,
  extractErrorDetails,
  formatErrorMessage,
  mapToRpcException,
} from './grpc-error.util';

const context = { service: 'pontusx', where: 'publishAsset' };

describe('error formatting', () => {
  it.each(['Plain error', new Error('Plain error')])(
    'preserves ordinary messages: %p',
    (error) => {
      expect(formatErrorMessage(error)).toBe('Plain error');
    },
  );

  it('preserves nested objects and arrays in HTTP error messages and details', () => {
    const data = {
      message: { services: ['At least one service is required'] },
    };
    const payload = extractRpcError(
      mapToRpcException({ response: { status: 400, data } }, context),
    );
    expect(payload.code).toBe(status.INVALID_ARGUMENT);
    expect(payload.message).toBe('services: At least one service is required');
    expect(JSON.parse(payload.details)).toEqual(data);
    expect(payload.metadata.get('x-service')).toEqual(['pontusx']);
  });

  it('preserves structured RpcException payloads', () => {
    const error = new RpcException({
      code: status.NOT_FOUND,
      message: { asset: 'Missing' },
      details: { did: 'did:op:test' },
    });
    expect(formatErrorMessage(error)).toBe('asset: Missing');
    expect(JSON.parse(extractRpcError(error).details)).toEqual({
      did: 'did:op:test',
    });
  });

  it('handles circular data and bigint without throwing while handling an error', () => {
    const message: any = { count: 1n, nested: { reason: 'Invalid services' } };
    message.self = message;
    const payload = extractRpcError(mapToRpcException({ message }, context));
    expect(payload.message).toContain('Invalid services');
    expect(payload.message).toContain('Circular');
    expect(payload.message).not.toContain('[object Object]');
    expect(formatErrorMessage({ message: { count: 1n } })).toBe('count: 1');
  });

  it('bounds serialized response bodies and preserves the original stack', () => {
    const error = Object.assign(new Error('Validation failed'), {
      response: { status: 400, data: { description: 'x'.repeat(9000) } },
    });
    const mapped = mapToRpcException(error, context);
    expect(extractRpcError(mapped).details).toHaveLength(8001);
    expect(mapped.stack).toBe(error.stack);
  });

  it('summarizes prefixed JSON once while preserving structured details and stack frames', () => {
    const details = {
      errors: { services: 'At least one service is required' },
    };
    const error = Object.assign(
      new Error(`Validating Metadata failed: ${JSON.stringify(details)}`),
      { status: 400, details },
    );
    const mapped = mapToRpcException(error, context);
    expect(extractRpcError(mapped).message).toBe(
      'Validating Metadata failed: services: At least one service is required',
    );
    expect(JSON.parse(extractRpcError(mapped).details)).toEqual(details);
    expect(mapped.stack.split('\n').slice(1)).toEqual(
      error.stack.split('\n').slice(1),
    );
    expect(mapped.stack.split('\n')[0]).not.toContain('{');
  });

  it('removes gRPC transport prefixes and retains machine-readable HTTP details', () => {
    const details = JSON.stringify({ errors: { services: 'Required' } });
    const error = {
      code: status.INVALID_ARGUMENT,
      message: `3 INVALID_ARGUMENT: ${details}`,
      details,
    };
    expect(formatErrorMessage(error)).toBe('services: Required');
    expect(extractErrorDetails(error)).toEqual({
      errors: { services: 'Required' },
    });
    expect(
      formatErrorMessage({
        code: status.NOT_FOUND,
        message: '5 NOT_FOUND: Not found',
        details: 'Not found',
      }),
    ).toBe('Not found');
  });

  it('handles multiple fields, nested objects, arrays, and unfamiliar schemas', () => {
    expect(
      formatErrorMessage({
        errors: {
          services: ['Required', 'Invalid'],
          metadata: { name: 'Missing' },
        },
      }),
    ).toBe('services: Required; services: Invalid; metadata.name: Missing');
    expect(
      formatErrorMessage({
        problems: [
          { field: 'name', reason: 'Required' },
          { field: 'author', reason: 'Unknown' },
        ],
      }),
    ).toBe(
      'problems[0].field: name; problems[0].reason: Required; problems[1].field: author; problems[1].reason: Unknown',
    );
    expect(formatErrorMessage({ errors: ['First', 'Second'] })).toBe(
      'First; Second',
    );
    expect(
      formatErrorMessage({ errors: { services: 'Invalid' }, requestId: '123' }),
    ).toBe('errors.services: Invalid; requestId: 123');
  });

  it.each([
    'Connection failed',
    'Invalid metadata: {broken JSON}',
    'Invalid URL: https://example.org',
    '42',
  ])('preserves unrecognized text: %s', (message) => {
    expect(formatErrorMessage(message)).toBe(message);
  });
});
