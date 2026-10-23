import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * Logs the state of the Redis connection through the Nest logger. ioredis reconnects on its
 * own and, without an `error` listener, prints every failed attempt to the console: one
 * error per outage is logged here, the retries only at debug level.
 */
export function logRedisConnection(
  client: Pick<Redis, 'on'>,
  address: string,
  logger = new Logger('Redis'),
) {
  // REDIS_ADDRESS may carry credentials (user:password@host:port)
  const target = address.replace(/^.*@/, '');
  let failing = false;

  client.on('error', (err: Error) => {
    if (failing) {
      logger.debug(`Redis at ${target} still unavailable: ${err.message}`);
      return;
    }
    failing = true;
    logger.error(
      `Connection to Redis at ${target} failed, retrying: ${err.message}`,
    );
  });

  client.on('ready', () => {
    logger.log(
      failing
        ? `Connection to Redis at ${target} restored`
        : `Connected to Redis at ${target}`,
    );
    failing = false;
  });
}
