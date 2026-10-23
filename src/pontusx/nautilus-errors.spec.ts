import { describe, it, expect, vi, type Mock } from 'vitest';
// Nautilus v2 validates the DDO locally and throws a DdoValidationError with the failing
// fields; the gateway passes them on as INVALID_ARGUMENT with structured details.
import { DdoValidationError } from '@deltadao/nautilus';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import { Mutex } from 'async-mutex';
import { PontusxService } from './pontusx.service.js';
import { Network, PRICING_CONFIGS, resolveNetworkConfig } from './config.js';

// the default network, without environment overrides
const NETWORK_CONFIG = resolveNetworkConfig(Network.OPSEPOLIA, () => undefined);
import { PontusxOffering, Pricing_PricingType } from '../generated/spp_v3.js';

describe('Nautilus validation errors', () => {
  function createService(publish: Mock) {
    const service = Object.create(PontusxService.prototype) as PontusxService;
    Object.assign(service, {
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      configService: { get: vi.fn() },
      networkConfig: NETWORK_CONFIG,
      pricingConfig: PRICING_CONFIGS.OPSEPOLIA,
      wallet: {
        getAddress: vi
          .fn()
          .mockResolvedValue('0x0000000000000000000000000000000000000001'),
      },
      remoteStore: {},
      mutex: new Mutex(),
      nautilus: { publish },
    });
    return service;
  }

  const offering: PontusxOffering = {
    metadata: {
      type: 'dataset',
      name: 'Dataset',
      description: '',
      author: 'PTW',
      license: '',
      tags: [],
      categories: [],
      links: {},
    },
    services: [
      {
        type: 'access',
        files: [],
        pricing: { pricingType: Pricing_PricingType.FREE },
        consumerParameters: [],
      },
    ],
    additionalInformation: undefined,
  };

  it('preserves the failing fields of the validation', async () => {
    const errors = {
      providedBy: ['Less than 1 values'],
      fullReport: ['<raw SHACL report>'],
    };
    const service = createService(
      vi.fn().mockRejectedValue(new DdoValidationError(errors)),
    );

    await expect(service.publishAsset(offering)).rejects.toMatchObject({
      error: {
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: 'DDO validation failed: providedBy: Less than 1 values',
        details: JSON.stringify({ providedBy: ['Less than 1 values'] }),
      },
    });
  });

  it('rejects a request the asset builder refuses before anything is sent', async () => {
    const publish = vi.fn();
    const service = createService(publish);

    await expect(
      service.publishAsset({
        ...offering,
        metadata: { ...offering.metadata, author: '' },
      }),
    ).rejects.toMatchObject({
      error: {
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: expect.stringContaining('providedBy'),
      },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('maps ocean-node errors by their HTTP status', async () => {
    const service = createService(
      vi.fn().mockRejectedValue(
        Object.assign(new Error('[ocean-node] encrypt: HTTP 401'), {
          status: 401,
        }),
      ),
    );

    await expect(service.publishAsset(offering)).rejects.toMatchObject({
      error: { code: GrpcStatusCode.UNAUTHENTICATED },
    });
  });

  it('passes on the nautilus operation id for its log lines', async () => {
    const service = createService(
      vi.fn().mockRejectedValue(
        Object.assign(new Error('[ocean-node] encrypt: HTTP 502'), {
          status: 502,
          opId: 'a1b2c3d4e5f6',
        }),
      ),
    );

    const error = await service.publishAsset(offering).catch((err) => err);

    expect(error.getError().metadata.get('x-nautilus-op-id')).toEqual([
      'a1b2c3d4e5f6',
    ]);
  });
});
