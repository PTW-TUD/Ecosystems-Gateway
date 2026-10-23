import { Logger } from '@nestjs/common';
import {
  type DebugLevel,
  type DebugTopic,
  type LogEvent,
  type LoggingLevel,
  Nautilus,
} from '@deltadao/nautilus';
import type { LogFormat } from '../logging.js';

// nautilus v2 level names and, for existing configurations, the v1 ones.
const NAUTILUS_LOG_LEVELS: Record<string, LoggingLevel> = {
  silent: 'silent',
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'trace',
  none: 'silent',
  log: 'info',
  verbose: 'trace',
};

// ocean.js reports a chain it ships no addresses for as an error, although the gateway's
// network config has them (Pontus-X testnet); nautilus refuses to start if any are missing.
const HARMLESS_OCEANJS_ERRORS = [/^No config found for given network/];

export interface NautilusLoggingOptions {
  /** NAUTILUS_LOG_LEVEL; unset, the most verbose level the Nest logger prints. */
  level?: string;
  format: LogFormat;
  /** NAUTILUS_DEBUG and NAUTILUS_DEBUG_TOPICS: nautilus' sensitive debug channel. */
  debug?: string;
  debugTopics?: string;
}

/**
 * Hands nautilus' log events, which nautilus redacts, to the Nest logger, with the context
 * `Nautilus:<component>`. Applies to the whole process, ocean.js' own log lines included.
 * Returns the problems found in the settings.
 */
export function configureNautilusLogging(
  options: NautilusLoggingOptions,
): string[] {
  const problems: string[] = [];

  let level = defaultNautilusLevel();
  const configured = options.level?.trim().toLowerCase();
  if (configured) {
    if (configured in NAUTILUS_LOG_LEVELS) {
      level = NAUTILUS_LOG_LEVELS[configured];
    } else {
      problems.push(
        `NAUTILUS_LOG_LEVEL '${configured}' is not supported; use silent, error, warn, info, debug or trace.`,
      );
    }
  }

  const loggers = new Map<string, Logger>();
  const loggerFor = (component: string) => {
    let logger = loggers.get(component);
    if (!logger) {
      logger = new Logger(`Nautilus:${component}`);
      loggers.set(component, logger);
    }
    return logger;
  };

  Nautilus.configureLogging({
    level,
    sink: (event) => {
      const message =
        options.format === 'json' ? toJsonMessage(event) : toTextMessage(event);
      const logger = loggerFor(event.component);
      switch (levelOf(event)) {
        case 'error':
          logger.error(message);
          break;
        case 'warn':
          logger.warn(message);
          break;
        case 'info':
          logger.log(message);
          break;
        case 'debug':
          logger.debug(message);
          break;
        default:
          logger.verbose(message);
      }
    },
  });

  // nautilus reads NAUTILUS_DEBUG itself when it is imported, before the .env file is
  // loaded. Its output deliberately stays on stderr, apart from the regular logs.
  const debug = options.debug?.trim().toLowerCase();
  if (debug) {
    try {
      const topics = options.debugTopics
        ?.split(',')
        .map((topic) => topic.trim())
        .filter(Boolean);
      Nautilus.setDebug({
        level: debug as DebugLevel,
        ...(topics?.length ? { topics: topics as DebugTopic[] } : {}),
      });
    } catch (err) {
      problems.push(`NAUTILUS_DEBUG: ${(err as Error).message}`);
    }
  }

  return problems;
}

function levelOf(event: LogEvent): LogEvent['level'] {
  const harmless =
    event.component === 'oceanjs' &&
    HARMLESS_OCEANJS_ERRORS.some((pattern) => pattern.test(event.msg));
  return harmless ? 'debug' : event.level;
}

// What the Nest logger prints anyway, so one setting is enough in the common case.
function defaultNautilusLevel(): LoggingLevel {
  if (Logger.isLevelEnabled('verbose')) return 'trace';
  if (Logger.isLevelEnabled('debug')) return 'debug';
  if (Logger.isLevelEnabled('log')) return 'info';
  if (Logger.isLevelEnabled('warn')) return 'warn';
  return 'error';
}

// `publish failed [publish.indexer.timeout publish#3fa2c1 did=did:ope:… 5012ms] {"…":…}`
function toTextMessage(event: LogEvent): string {
  const tags: string[] = [event.event];
  if (event.operation) {
    tags.push(`${event.operation}${event.opId ? `#${event.opId}` : ''}`);
  }
  if (event.did) tags.push(`did=${event.did}`);
  if (event.txHash) tags.push(`tx=${event.txHash}`);
  if (event.durationMs !== undefined) tags.push(`${event.durationMs}ms`);

  let fields = '';
  if (Object.keys(event.fields ?? {}).length) {
    try {
      fields = ` ${JSON.stringify(event.fields, bigintReplacer)}`;
    } catch {
      // Never let a log line break the call that emitted it.
    }
  }
  return `${event.msg} [${tags.join(' ')}]${fields}`;
}

// The JSON logger prints the message object as it is, so it must be plain JSON.
function toJsonMessage(event: LogEvent): object {
  const message = {
    msg: event.msg,
    event: event.event,
    operation: event.operation,
    opId: event.opId,
    did: event.did,
    txHash: event.txHash,
    durationMs: event.durationMs,
    fields: event.fields,
  };
  try {
    return JSON.parse(JSON.stringify(message, bigintReplacer));
  } catch {
    return { msg: event.msg, event: event.event };
  }
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}
