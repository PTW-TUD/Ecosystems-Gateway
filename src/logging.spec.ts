import { describe, it, expect } from 'vitest';
import { readLoggingSettings, redactForLog } from './logging.js';

describe('readLoggingSettings', () => {
  it('logs log and warn by default, and errors always', () => {
    const settings = readLoggingSettings({});

    expect(settings.levels.sort()).toEqual(['error', 'fatal', 'log', 'warn']);
    expect(settings.format).toBe('text');
    expect(settings.problems).toEqual([]);
  });

  it('reports unknown levels and formats instead of passing them on', () => {
    const settings = readLoggingSettings({
      NESTJS_LOG_LEVELS: 'log, DEBUG,info',
      LOG_FORMAT: 'xml',
    });

    expect(settings.levels.sort()).toEqual(['debug', 'error', 'fatal', 'log']);
    expect(settings.format).toBe('text');
    expect(settings.problems).toEqual([
      expect.stringContaining("unknown level 'info'"),
      expect.stringContaining("LOG_FORMAT 'xml'"),
    ]);
  });

  it('selects JSON logs', () => {
    expect(readLoggingSettings({ LOG_FORMAT: 'JSON' }).format).toBe('json');
  });
});

describe('redactForLog', () => {
  it('masks credentials of a request and keeps the rest', () => {
    const request = {
      offerings: [
        {
          pontusxOffering: {
            services: [
              {
                tokenName: 'Data Access Token',
                files: [
                  {
                    url: 'https://example.org/data',
                    headers: { Authorization: 'Basic abc', 'X-Trace': '1' },
                  },
                ],
              },
            ],
          },
        },
      ],
      service: { pontusxService: { userdata: { apiUser: 'me' } } },
      clientSecret: 's3cret',
      accessToken: 'ey…',
      amount: 10n,
    };

    expect(redactForLog(request)).toEqual({
      offerings: [
        {
          pontusxOffering: {
            services: [
              {
                tokenName: 'Data Access Token',
                files: [
                  {
                    url: 'https://example.org/data',
                    headers: {
                      Authorization: '<redacted>',
                      'X-Trace': '<redacted>',
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      service: { pontusxService: { userdata: { apiUser: '<redacted>' } } },
      clientSecret: '<redacted>',
      accessToken: '<redacted>',
      amount: '10',
    });
  });

  it('cuts long strings such as presentations', () => {
    const redacted = redactForLog({ VP: 'x'.repeat(5000) }) as { VP: string };

    expect(redacted.VP).toHaveLength(1000 + '…(5000 characters)'.length);
  });
});
