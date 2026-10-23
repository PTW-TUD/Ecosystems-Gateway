import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { logRedisConnection } from './redis-logging.js';

describe('logRedisConnection', () => {
  function connect(address = '127.0.0.1:6379') {
    const client = new EventEmitter();
    const logger = {
      log: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    logRedisConnection(client as any, address, logger as unknown as Logger);
    return { client, logger };
  }

  it('logs one error per outage and the retries at debug level', () => {
    const { client, logger } = connect();

    client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    client.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Connection to Redis at 127.0.0.1:6379 failed, retrying: connect ECONNREFUSED 127.0.0.1:6379',
    );
    expect(logger.debug).toHaveBeenCalledTimes(1);

    client.emit('ready');
    expect(logger.log).toHaveBeenCalledWith(
      'Connection to Redis at 127.0.0.1:6379 restored',
    );

    client.emit('error', new Error('read ECONNRESET'));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('logs the first connection', () => {
    const { client, logger } = connect();

    client.emit('ready');

    expect(logger.log).toHaveBeenCalledWith(
      'Connected to Redis at 127.0.0.1:6379',
    );
  });

  it('leaves credentials in the address out', () => {
    const { client, logger } = connect('user:secret@redis:6379');

    client.emit('error', new Error('NOAUTH'));

    expect(logger.error).toHaveBeenCalledWith(
      'Connection to Redis at redis:6379 failed, retrying: NOAUTH',
    );
  });
});
