import { ConsoleLogger, LogLevel } from '@nestjs/common';

const NEST_LOG_LEVELS: readonly LogLevel[] = [
  'verbose',
  'debug',
  'log',
  'warn',
  'error',
  'fatal',
];

// Errors are never hidden, whatever NESTJS_LOG_LEVELS lists.
const ALWAYS_ENABLED: readonly LogLevel[] = ['error', 'fatal'];

export type LogFormat = 'text' | 'json';

export interface LoggingSettings {
  levels: LogLevel[];
  format: LogFormat;
  /** Settings that could not be read, to be logged once the logger exists. */
  problems: string[];
}

/**
 * NESTJS_LOG_LEVELS (comma separated, e.g. `log,warn,debug`) and LOG_FORMAT (`text` or
 * `json`), read before the app and its ConfigService exist.
 */
export function readLoggingSettings(
  env: NodeJS.ProcessEnv = process.env,
): LoggingSettings {
  const problems: string[] = [];

  const levels = new Set<LogLevel>(ALWAYS_ENABLED);
  for (const entry of (env.NESTJS_LOG_LEVELS || 'log,warn').split(',')) {
    const level = entry.trim().toLowerCase();
    if (!level) continue;
    if (NEST_LOG_LEVELS.includes(level as LogLevel)) {
      levels.add(level as LogLevel);
    } else {
      problems.push(
        `NESTJS_LOG_LEVELS contains unknown level '${level}'; use ${NEST_LOG_LEVELS.join(', ')}.`,
      );
    }
  }

  const configuredFormat = (env.LOG_FORMAT || 'text').trim().toLowerCase();
  let format: LogFormat = 'text';
  if (configuredFormat === 'json') {
    format = 'json';
  } else if (configuredFormat !== 'text') {
    problems.push(
      `LOG_FORMAT '${configuredFormat}' is not supported; use text or json.`,
    );
  }

  return { levels: [...levels], format, problems };
}

export function createAppLogger(settings: LoggingSettings): ConsoleLogger {
  return new ConsoleLogger({
    logLevels: settings.levels,
    json: settings.format === 'json',
    depth: Infinity,
  });
}

// Keys whose values are credentials: request headers of a data source, userdata forwarded
// to it, and anything that names a secret. `tokenName`/`tokenSymbol` are datatoken names.
const MASKED_OBJECTS = new Set(['headers', 'userdata']);
const SENSITIVE_KEY =
  /authorization|cookie|secret|passw(or)?d|api[-_]?key|private[-_]?key|jwt|token$/i;
const MAX_STRING_LENGTH = 1000;
const REDACTED = '<redacted>';

/** A copy of a request or payload that is safe to log: credentials masked, long strings cut. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[Nested]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…(${value.length} characters)`
      : value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.map((entry) => redactForLog(entry, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SENSITIVE_KEY.test(key)) return [key, REDACTED];
      if (MASKED_OBJECTS.has(key) && entry && typeof entry === 'object') {
        return [
          key,
          Object.fromEntries(
            Object.keys(entry).map((name) => [name, REDACTED]),
          ),
        ];
      }
      return [key, redactForLog(entry, depth + 1)];
    }),
  );
}
