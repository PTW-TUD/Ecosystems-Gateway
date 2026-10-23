import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { GrpcController } from './grpc.controller.js';
import { PontusxService } from './pontusx/pontusx.service.js';
import {
  CreateComputeToDataRequest,
  CreateComputeToDataResultRequest,
  GetComputeToDataResultResponse,
  GetOfferingRequest,
  Pricing_PricingType,
  PontusxOffering,
  ComputeToDataResultType,
} from './generated/spp_v3.js';
import { RpcException } from '@nestjs/microservices';
import { XfscService } from './xfsc/xfsc.service.js';
import { Metadata, status as GrpcStatusCode } from '@grpc/grpc-js';

describe('Grpc Controller', () => {
  let controller: GrpcController;
  let pontusxService: PontusxService;

  const mockPontusXService = {
    publishAsset: vi.fn(() => ({
      ddo: { id: 'test-id' },
    })),
    updateOffering: vi.fn(),
    updateOfferingLifecycle: vi.fn(),
    getOffering: vi.fn(),
    getComputeToDataStatus: vi.fn(),
  };

  const mockXFSCService = {
    publish: vi.fn().mockResolvedValue('test-id'),
    update: vi.fn().mockResolvedValue('test-id'),
    delete: vi.fn(),
    revoke: vi.fn().mockResolvedValue('test-id'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrpcController],
      providers: [
        {
          provide: PontusxService,
          useValue: mockPontusXService,
        },
        {
          provide: XfscService,
          useValue: mockXFSCService,
        },
      ],
    }).compile();

    controller = module.get<GrpcController>(GrpcController);
    pontusxService = module.get<PontusxService>(PontusxService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('Create offering', async () => {
    const result = await controller.createOffering({
      offerings: [
        {
          pontusxOffering: {
            metadata: {
              type: 'dataset',
              name: '',
              author: '',
              license: '',
              tags: [],
              categories: [],
              links: {},
              description: '',
            },
            services: [
              {
                type: 'access',
                files: [
                  {
                    url: '',
                    method: '',
                    headers: {},
                  },
                ],
                pricing: {
                  pricingType: Pricing_PricingType.FREE,
                },
                consumerParameters: [],
              },
            ],
            credentials: {
              allow: [],
              deny: [],
            },
            additionalInformation: undefined,
          },
        },
      ],
    });

    expect(mockPontusXService.publishAsset.mock.calls).toHaveLength(1);
    expect(result.id[0]).toEqual('test-id');
  });

  describe('error logging', () => {
    const jobId = `0x${'a'.repeat(64)}-${'b'.repeat(64)}`;
    let logger: { warn: any; error: any };

    beforeEach(() => {
      logger = (controller as any).logger;
      vi.spyOn(logger as any, 'warn').mockImplementation(() => undefined);
      vi.spyOn(logger as any, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('logs errors caused by the request as warnings, with the nautilus operation', async () => {
      const metadata = new Metadata();
      metadata.set('x-nautilus-op-id', 'a1b2c3d4e5f6');
      mockPontusXService.getComputeToDataStatus.mockRejectedValueOnce(
        new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message: 'Compute job not found',
          metadata,
        }),
      );

      await expect(
        controller.GetComputeToDataStatus({ jobId }),
      ).rejects.toBeInstanceOf(RpcException);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Compute job not found (nautilus op a1b2c3d4e5f6)',
        ),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs other failures as errors with their stack', async () => {
      mockPontusXService.getComputeToDataStatus.mockRejectedValueOnce(
        new Error('socket hang up'),
      );

      await expect(
        controller.GetComputeToDataStatus({ jobId }),
      ).rejects.toMatchObject({ error: { code: GrpcStatusCode.INTERNAL } });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('INTERNAL'),
        expect.stringContaining('socket hang up'),
      );
    });

    it('reports a job that just started', async () => {
      mockPontusXService.getComputeToDataStatus.mockResolvedValueOnce(0);

      await expect(
        controller.GetComputeToDataStatus({ jobId }),
      ).resolves.toEqual({ status: 0, description: 'Job started | REQUESTED' });
    });
  });
});
