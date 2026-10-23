import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  type LogEvent,
  type LoggingConfig,
  Nautilus,
} from '@deltadao/nautilus';
import { configureNautilusLogging } from './nautilus-logging.js';

describe('configureNautilusLogging', () => {
  let configureLogging: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureLogging = vi
      .spyOn(Nautilus, 'configureLogging')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function configured(): LoggingConfig {
    return configureLogging.mock.calls[0][0] as LoggingConfig;
  }

  const event: LogEvent = {
    time: '2026-10-23T08:00:00.000Z',
    level: 'warn',
    event: 'publish.preflight.denies_all',
    component: 'publish',
    msg: 'nobody can download it',
    operation: 'publish',
    opId: 'a1b2c3d4e5f6',
    did: 'did:ope:1',
    durationMs: 12,
    fields: { amount: 10n },
  } as LogEvent;

  it.each([
    ['debug', 'debug'],
    ['verbose', 'trace'],
    ['none', 'silent'],
  ])('maps NAUTILUS_LOG_LEVEL %s to %s', (level, expected) => {
    expect(configureNautilusLogging({ level, format: 'text' })).toEqual([]);
    expect(configured().level).toBe(expected);
  });

  it('follows the Nest log levels when no level is set', () => {
    vi.spyOn(Logger, 'isLevelEnabled').mockImplementation(
      (level) => level !== 'verbose',
    );

    configureNautilusLogging({ format: 'text' });

    expect(configured().level).toBe('debug');
  });

  it('reports an unknown level', () => {
    expect(configureNautilusLogging({ level: 'loud', format: 'text' })).toEqual(
      [expect.stringContaining("NAUTILUS_LOG_LEVEL 'loud'")],
    );
  });

  it('logs events with their operation, asset and fields', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    configureNautilusLogging({ level: 'info', format: 'text' });
    configured().sink(event);

    expect(warn).toHaveBeenCalledWith(
      'nobody can download it [publish.preflight.denies_all publish#a1b2c3d4e5f6 did=did:ope:1 12ms] {"amount":"10"}',
    );
    expect((warn.mock.contexts[0] as any).context).toBe('Nautilus:publish');
  });

  it('logs events as plain objects for JSON logs', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    configureNautilusLogging({ level: 'info', format: 'json' });
    configured().sink(event);

    expect(warn).toHaveBeenCalledWith({
      msg: 'nobody can download it',
      event: 'publish.preflight.denies_all',
      operation: 'publish',
      opId: 'a1b2c3d4e5f6',
      did: 'did:ope:1',
      durationMs: 12,
      fields: { amount: '10' },
    });
  });

  it("logs ocean.js' missing defaults for a configured chain at debug level", () => {
    const debug = vi
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    configureNautilusLogging({ level: 'info', format: 'text' });
    configured().sink({
      ...event,
      level: 'error',
      component: 'oceanjs',
      event: 'oceanjs.logger.error',
      msg: "No config found for given network '32457'",
    } as LogEvent);

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("No config found for given network '32457'"),
    );
    expect(error).not.toHaveBeenCalled();
  });
});
