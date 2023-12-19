import { Test, TestingModule } from '@nestjs/testing';
import { CredentialEventServiceService } from './credential-event-service.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

describe('CredentialEventServiceService', () => {
  let service: CredentialEventServiceService;
  let httpService: HttpService;
  const mockHttpService = {
    axiosRef: {
      request: jest.fn(),
      post: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialEventServiceService,
        HttpService,
        ConfigService,
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
      ],
    }).compile();

    service = module.get<CredentialEventServiceService>(
      CredentialEventServiceService,
    );
    httpService = module.get<HttpService>(HttpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(httpService).toBeDefined();
  });
});
