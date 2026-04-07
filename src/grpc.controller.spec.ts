import { Test, TestingModule } from '@nestjs/testing';
import { GrpcController } from './grpc.controller';
import { PontusxService } from './pontusx/pontusx.service';
import {
  CreateComputeToDataRequest,
  CreateComputeToDataResultRequest,
  GetComputeToDataResultResponse,
  GetOfferingRequest,
  Pricing_PricingType,
  PontusxOffering,
  ComputeToDataResultType,
} from './generated/spp_v2';
import { RpcException } from '@nestjs/microservices';
import { XfscService } from './xfsc/xfsc.service';

describe('Grpc Controller', () => {
  let controller: GrpcController;
  let pontusxService: PontusxService;

  const mockPontusXService = {
    publishAsset: jest.fn(() => ({
      ddo: { id: 'test-id' },
    })),
    updateOffering: jest.fn(),
    updateOfferingLifecycle: jest.fn(),
    getOffering: jest.fn(),
  };

  const mockXFSCService = {
    publish: jest.fn().mockResolvedValue('test-id'),
    update: jest.fn().mockResolvedValue('test-id'),
    delete: jest.fn(),
    revoke: jest.fn().mockResolvedValue('test-id'),
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
              licence: '',
              tags: [],
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
});
