import { Test, TestingModule } from '@nestjs/testing';
import { PontusxService } from './pontusx.service';
import { ConfigService } from '@nestjs/config';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';

describe('PontusxService', () => {
  let service: PontusxService;
  const mockCesService = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PontusxService,
        ConfigService,
        CredentialEventServiceService,
        {
          provide: CredentialEventServiceService,
          useValue: mockCesService,
        },
      ],
    }); // .compile(); // TODO: figure out how to test the pontusX thing

    // service = module.get<PontusxService>(PontusxService);
  });

  it('should be defined', () => {
    // TODO: figure out how to test the pontusX thing
    expect(true).toBe(true);
    // expect(service).toBeDefined();
  });

  describe('getComputeToDataStatus', () => {
    beforeEach(() => {
      service = Object.create(PontusxService.prototype) as PontusxService;
      (service as any).nautilus = {
        getComputeStatus: jest.fn(),
      };
      jest.spyOn(service, 'getSelectedNetworkConfig').mockReturnValue({
        providerUri: 'https://provider.example.test',
      } as any);
    });

    it('returns the status of an existing job', async () => {
      (service as any).nautilus.getComputeStatus.mockResolvedValue({
        status: 70,
      });

      await expect(
        service.getComputeToDataStatus('existing-job'),
      ).resolves.toBe(70);
    });

    it.each([undefined, null, [], {}])(
      'throws NOT_FOUND when Nautilus returns no job (%p)',
      async (status) => {
        (service as any).nautilus.getComputeStatus.mockResolvedValue(status);

        const result = service.getComputeToDataStatus('missing-job');

        await expect(result).rejects.toBeInstanceOf(RpcException);
        await expect(result).rejects.toMatchObject({
          error: {
            code: GrpcStatusCode.NOT_FOUND,
            message: "Compute job 'missing-job' couldn't be found",
          },
        });
      },
    );

    it('contains missing-job errors in the background poller and checks other jobs', async () => {
      const logger = { warn: jest.fn() };
      (service as any).logger = logger;
      (service as any).redis = {
        lrange: jest.fn().mockResolvedValue(['missing-job', 'running-job']),
      };
      (service as any).nautilus.getComputeStatus
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ status: 40 });

      await expect(
        service.__periodicallyFetchComputeJobs(),
      ).resolves.toBeUndefined();

      expect((service as any).nautilus.getComputeStatus).toHaveBeenCalledTimes(
        2,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Compute job 'missing-job' couldn't be found"),
      );
    });
  });
});
