import {
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Network,
  NETWORK_CONFIGS,
  NetworkConfig,
  PRICING_CONFIGS,
  PricingConfig,
} from './config';
import { Wallet, providers } from 'ethers';
import {
  LogLevel,
  Nautilus,
  AssetBuilder,
  FileTypes,
  ServiceBuilder,
  ServiceTypes,
  UrlFile,
  LifecycleStates,
  ComputeConfig,
  MetadataConfig,
  CredentialListTypes,
} from '@deltadao/nautilus';
import { ConsumerParameter } from '@oceanprotocol/lib';
import { type Asset } from '@oceanprotocol/lib';
import {
  PontusxOffering,
  pricing_PricingTypeToJSON,
  PontusxUpdateOffering,
  Service,
  UpdateOfferingRequest_UpdateOffering,
  ComputeToDataResultType,
  ComputeToDataResponse,
  GetComputeToDataResultResponse,
  ComputeToDataResponseState,
} from '../generated/spp_v2';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import Redis from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios, { AxiosResponse } from 'axios';
import { Mutex } from 'async-mutex';
import { capitalize } from './utility';

@Injectable()
export class PontusxService implements OnModuleInit {
  private readonly logger = new Logger(PontusxService.name);
  private readonly selectedNetwork: string;
  private readonly networkConfig: NetworkConfig;
  private readonly pricingConfig: PricingConfig;
  private readonly wallet: Wallet;
  private readonly provider: providers.JsonRpcProvider;
  private nautilus: Nautilus;
  private nautilusLogLevel: LogLevel;
  // there should only be one action with one private key at a time on the pontus-x network
  private mutex: Mutex;

  constructor(
    private readonly configService: ConfigService,
    private readonly credentialEventService: CredentialEventServiceService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.selectedNetwork = this.configService
      .getOrThrow('NETWORK')
      .toUpperCase();

    if (!(this.selectedNetwork in Network)) {
      this.logger.error(
        `Invalid network selection: ${
          this.selectedNetwork
        }. Supported networks are ${Object.values(Network).join(', ')}.`,
      );
      throw `Invalid network selection: ${
        this.selectedNetwork
      }. Supported networks are ${Object.values(Network).join(', ')}.`;
    }
    this.networkConfig = NETWORK_CONFIGS[this.getSelectedNetwork()];
    this.pricingConfig = PRICING_CONFIGS[this.getSelectedNetwork()];
    this.provider = new providers.JsonRpcProvider(this.networkConfig.nodeUri);

    this.wallet = new Wallet(
      this.configService.getOrThrow('PRIVATE_KEY'),
      this.provider,
    );

    this.mutex = new Mutex();
  }

  async onModuleInit(): Promise<void> {
    this.nautilus = await Nautilus.create(
      this.wallet,
      this.getSelectedNetworkConfig(),
    );
    // some ugly conversion so there is no need to capitalize the env variable
    const logLevel = this.configService.get('NAUTILUS_LOG_LEVEL', 'Log');
    const logLevelEnum: LogLevel =
      LogLevel[capitalize(logLevel) as keyof typeof LogLevel];
    if (!logLevelEnum) {
      this.logger.warn(
        'Log level for Nautilus not recognised. Needs to be __one__ out of none, error, warn, log, verbose.',
      );
    }
    Nautilus.setLogLevel(logLevelEnum);
  }

  getSelectedNetwork() {
    return this.selectedNetwork;
  }

  getSelectedNetworkConfig() {
    return this.networkConfig;
  }

  setLogLevel(level: LogLevel) {
    this.nautilusLogLevel = level;
  }

  async publishAsset(offering: PontusxOffering) {
    const release = await this.mutex.acquire();
    try {
      const owner = await this.wallet.getAddress();
      this.logger.debug(`Your address is ${owner}`);

      const assetBuilder = new AssetBuilder();

      const filled_assetBuilder = this.fillAsset(assetBuilder, offering, owner);

      for (const service of offering.services) {
        const serviceBuilder = new ServiceBuilder({
          serviceType: service.type as ServiceTypes,
          fileType: FileTypes.URL,
        }); // only URL data source supported

        const NautilusService = this.buildService(
          serviceBuilder,
          offering,
          service,
        );

        assetBuilder.addService(NautilusService);
      }

      const asset = filled_assetBuilder.build();

      const result = await this.nautilus.publish(asset);
      return result;
    } finally {
      release();
    }
  }

  async updateOffering(UpdateOffering: UpdateOfferingRequest_UpdateOffering) {
    const release = await this.mutex.acquire();
    try {
      const offering = UpdateOffering.pontusxUpdateOffering;
      const aquariusAsset = await this.nautilus.getAquariusAsset(offering.did);

      let filled_assetBuilder: AssetBuilder;
      if (offering.metadata !== undefined) {
        const assetBuilder = new AssetBuilder(aquariusAsset);
        this.logger.debug('Updating metadata of Pontus-X asset');
        const owner = await this.wallet.getAddress();
        filled_assetBuilder = this.fillAsset(assetBuilder, offering, owner);
      } else {
        filled_assetBuilder = new AssetBuilder(aquariusAsset);
      }

      let updatedInd: Array<Number> = [];

      offering.updateServices?.forEach((updateService) => {
        let serviceInd: number = 0;
        if (updateService.index !== undefined) {
          if (updateService.index in aquariusAsset.services) {
            serviceInd = updateService.index;
          } else {
            throw new RpcException({
              code: GrpcStatusCode.OUT_OF_RANGE,
              message: `The requested service index ${updateService.index} is out of range of the existing services of the asset`,
            });
          }
        }
        if (updatedInd.includes(serviceInd)) {
          if (serviceInd === 0) {
            this.logger.debug(
              `Updating only first service of asset ${offering.did} ...`,
            );
          } else {
            this.logger.debug(
              `Updating service with index ${serviceInd} of asset ${offering.did} ...`,
            );
          }

          const serviceBuilder = new ServiceBuilder({
            aquariusAsset,
            serviceId: aquariusAsset.services[serviceInd].id,
          });
          const NautilusService = this.buildService(
            serviceBuilder,
            offering,
            updateService.service,
          );
          filled_assetBuilder.addService(NautilusService);
          updatedInd.push(serviceInd);
        } else {
          this.logger.warn(
            `Skipping repeated update of service with index ${serviceInd}`,
          );
        }
      });

      const asset = filled_assetBuilder.build();
      const result = await this.nautilus.edit(asset);

      let cesResult;
      if (UpdateOffering.publishInfo !== undefined) {
        cesResult = await this.credentialEventService.publish(
          UpdateOffering.publishInfo.source,
          JSON.parse(UpdateOffering.publishInfo.data),
        );
      }

      return {
        pontus: result,
        ces: cesResult,
      };
    } finally {
      release();
    }
  }

  async setState(did: string, state: LifecycleStates) {
    const aquariusAsset = await this.nautilus.getAquariusAsset(did);

    const result = await this.nautilus.setAssetLifecycleState(
      aquariusAsset,
      state,
    );

    return result;
  }

  fillAsset(
    assetBuilder: AssetBuilder,
    offering: PontusxOffering | PontusxUpdateOffering,
    owner: string,
  ) {
    const assetType = <'dataset' | 'algorithm'>offering.metadata.type;
    assetBuilder
      .setType(assetType)
      .setName(offering.metadata.name)
      .setDescription(offering.metadata.description)
      .setAuthor(offering.metadata.author)
      .setLicense(offering.metadata.licence)
      .addTags(offering.metadata.tags)
      .setOwner(owner)
      .addAdditionalInformation(offering.additionalInformation);

    if (offering.credentials) {
      // nautilus does not allow empty arrays or undefined to be given here. Only call the function if there is something to add.
      if (offering.credentials.allow) {
        assetBuilder.addCredentialAddresses(
          CredentialListTypes.ALLOW,
          offering.credentials.allow,
        );
      }
      if (offering.credentials.deny) {
        assetBuilder.addCredentialAddresses(
          CredentialListTypes.DENY,
          offering.credentials.deny,
        );
      }
    }

    if (assetType === 'algorithm') {
      if (offering.metadata.algorithm !== undefined) {
        const algo: MetadataConfig['algorithm'] = {
          container: offering.metadata.algorithm.container,
        };
        if (offering.metadata.algorithm.language !== undefined) {
          algo.language = offering.metadata.algorithm.language;
        }
        if (offering.metadata.algorithm.version !== undefined) {
          algo.version = offering.metadata.algorithm.version;
        }
        offering.metadata.algorithm.consumerParameters?.forEach((par) => {
          let param: ConsumerParameter = {
            type: par.type as ConsumerParameter['type'],
            name: par.name, // link to your file or api
            label: par.label,
            required: par.required,
            default: par.default,
            description: par.description,
          };
          if (par.options !== undefined) {
            param.options = par.options.toString();
          }
          algo.consumerParameters.push(param);
        });
        assetBuilder.setAlgorithm(algo);
      } else {
        if (
          this.isPontusxOffering(offering) &&
          !this.isPontusxUpdateOffering(offering)
        ) {
          this.logger.error(
            `Algorithm Metadata is missing for asset ${offering.metadata.name} of type algorithm`,
          );
        } else if (this.isPontusxUpdateOffering(offering)) {
          this.logger.debug(
            `Not updating Algorithm Metadata as it is missing in the request`,
          );
        } else {
          throw new RpcException({
            code: GrpcStatusCode.INTERNAL,
            message: 'The message type does not fit a known Pontus-X request',
          });
        }
      }
    }
    return assetBuilder;
  }

  isPontusxOffering(message: any): message is PontusxOffering {
    return (
      'metadata' in message &&
      'additionalInformation' in message &&
      'services' in message
    );
  }
  isPontusxUpdateOffering(message: any): message is PontusxUpdateOffering {
    return (
      'did' in message &&
      'metadata' in message &&
      'additionalInformation' in message &&
      'updateServices' in message
    );
  }

  buildService(
    serviceBuilder: ServiceBuilder<ServiceTypes, FileTypes>,
    offering: PontusxOffering | PontusxUpdateOffering,
    service: Service,
  ) {
    serviceBuilder
      .setServiceEndpoint(this.networkConfig.providerUri)
      .setTimeout(service.timeout ?? 86400);

    if (service.name !== undefined) {
      serviceBuilder.setName(service.name);
    }
    if (service.description !== undefined) {
      serviceBuilder.setName(service.description);
    }
    if (service.tokenName && service.tokenSymbol) {
      serviceBuilder.setDatatokenNameAndSymbol(
        service.tokenName,
        service.tokenSymbol,
      ); // important for following access token transactions in the explorer
    }
    const pxOffering = this.isPontusxOffering(offering);
    const pxUpdateOffering = this.isPontusxUpdateOffering(offering);
    const servType = service.type as ServiceTypes;
    if (servType === ServiceTypes.COMPUTE) {
      if (service.computeOptions !== undefined) {
        if (service.computeOptions.allowRawAlgorithm !== undefined) {
          serviceBuilder.allowRawAlgorithms(
            service.computeOptions.allowRawAlgorithm,
          );
        } else {
          if (pxOffering && !pxUpdateOffering) {
            this.logger.debug(
              `Using default value 'false' for allowRawAlgorithm in computeOptions`,
            );
            serviceBuilder.allowRawAlgorithms(false);
          } else if (pxUpdateOffering) {
            this.logger.debug(
              'Not updating allowRawAlgorithm as it is missing in the request',
            );
          } else {
            throw new RpcException({
              code: GrpcStatusCode.INTERNAL,
              message: 'The message type does not fit a known Pontus-X request',
            });
          }
        }
        if (service.computeOptions.allowNetworkAccess !== undefined) {
          serviceBuilder.allowAlgorithmNetworkAccess(
            service.computeOptions.allowNetworkAccess,
          );
        } else {
          if (pxOffering && !pxUpdateOffering) {
            this.logger.debug(
              `Using default value 'false' for allowNetworkAccess in computeOptions`,
            );
            serviceBuilder.allowAlgorithmNetworkAccess(false);
          } else if (pxUpdateOffering) {
            this.logger.debug(
              'Not updating allowNetworkAccess as it is missing in the request',
            );
          } else {
            throw new RpcException({
              code: GrpcStatusCode.INTERNAL,
              message: 'The message type does not fit a known Pontus-X request',
            });
          }
        }
        if (service.computeOptions.trustedAlgorithms !== undefined) {
          serviceBuilder.addTrustedAlgorithms(
            service.computeOptions.trustedAlgorithms,
          );
        }

        service.computeOptions.trustedPublishers?.forEach((trustedPub) => {
          serviceBuilder.addTrustedAlgorithmPublisher(trustedPub);
        });
      } else {
        if (pxOffering && !pxUpdateOffering) {
          this.logger.error(
            `Compute Options are missing in service for asset ${offering.metadata.name} of type algorithm`,
          );
        } else if (pxUpdateOffering) {
          this.logger.debug(
            `Not updating Compute options of service for asset ${offering.did} as they are missing in the request`,
          );
        } else {
          throw new RpcException({
            code: GrpcStatusCode.INTERNAL,
            message: 'The message type does not fit a known Pontus-X request',
          });
        }
      }
    }
    let pricing =
      this.pricingConfig[
        pricing_PricingTypeToJSON(service.pricing.pricingType)
      ];
    if (pricing.type !== 'free') {
      pricing.freCreationParams.fixedRate =
        service.pricing.fixedRate.toString() ??
        pricing.freCreationParams.fixedRate;
      this.logger.debug(
        `Setting ${pricing_PricingTypeToJSON(
          service.pricing.pricingType,
        )} pricing with fixed Rate ${pricing.freCreationParams.fixedRate}`,
      );
    } else {
      this.logger.debug('Setting free pricing for service');
    }
    serviceBuilder.setPricing(pricing);

    service.files.forEach((file) => {
      const urlFile: UrlFile = {
        type: 'url',
        url: file.url,
        method: file.method,
      };
      if (file.headers !== undefined) {
        this.logger.debug(`Setting file headers: ${file.headers}`);
        urlFile.headers = file.headers;
      }
      serviceBuilder.addFile(urlFile);
    });

    service.consumerParameters?.forEach((par) => {
      let param: ConsumerParameter = {
        type: par.type as ConsumerParameter['type'],
        name: par.name, // link to your file or api
        label: par.label,
        required: par.required,
        default: par.default,
        description: par.description,
      };
      if (par.options !== undefined) {
        param.options = par.options.toString();
      }
      serviceBuilder.addConsumerParameter(param);
    });

    const NautilusService = serviceBuilder.build();

    return NautilusService;
  }

  async getOffering(did: string): Promise<Asset> {
    return await this.nautilus.getAquariusAsset(did);
  }

  async requestComputeToData(
    did: string,
    algo: string,
    userdata: {},
  ): Promise<string[]> {
    const release = await this.mutex.acquire();
    try {
      const computeConfig: Omit<ComputeConfig, 'signer' | 'chainConfig'> = {
        dataset: {
          did: did,
          userdata: userdata,
        },
        algorithm: { did: algo },
      };

      const dataset = await this.getOffering(computeConfig.dataset.did).catch(
        (_reason) => {
          throw new NotFoundException('Asset not found');
        },
      );

      // verify that requested asset has compute jobs available
      const compute_objects = dataset.services.filter((obj) => {
        return obj.type === 'compute';
      });
      if (compute_objects.length < 1) {
        throw new NotFoundException('No algorithms are available');
      }

      const computeJob = await this.nautilus
        .compute(computeConfig)
        .catch((error) => {
          throw new NotFoundException(
            `Compute to Data job cant start: ${error}`,
          );
        });

      let jobIds = [];
      if (computeJob instanceof Array) {
        await Promise.all(
          computeJob.map(async (job) => {
            await this.redis.rpush(
              `${this.getSelectedNetworkConfig().network}:ctd:pending`,
              job.jobId,
            );
            jobIds.push(job.jobId);
          }),
        );
      } else {
        await this.redis.rpush(
          `${this.getSelectedNetworkConfig().network}:ctd:pending`,
          computeJob.jobId,
        );
        jobIds.push(computeJob.jobId);
      }

      return jobIds;
    } finally {
      release();
    }
  }

  async getComputeToDataStatus(jobId: string): Promise<number> {
    let status = await this.nautilus.getComputeStatus({
      jobId: jobId,
      providerUri: this.getSelectedNetworkConfig().providerUri,
    });

    return status.status;
  }

  async getComputeToDataResult(
    jobId: string,
    return_type: ComputeToDataResultType,
    jobIndex: number,
  ): Promise<GetComputeToDataResultResponse> {
    switch (return_type) {
      case ComputeToDataResultType.C2D_DATA:
        let cached = await this.redis.get(
          `${this.getSelectedNetworkConfig().network}:ctd:result:${jobId}`,
        );
        if (cached === null) {
          let queued = await this.redis.lpos(
            `${this.getSelectedNetworkConfig().network}:ctd:pending`,
            jobId,
          );
          if (queued != null) {
            return {
              state: ComputeToDataResponseState.IN_PROGRESS,
              data: 'Data has been queued, processing started',
            };
          }

          await this.redis.rpush(
            `${this.getSelectedNetworkConfig().network}:ctd:pending`,
            jobId,
          );
          return {
            state: ComputeToDataResponseState.QUEUED,
            data: 'Data has been queued, waiting to be processed',
          };
        }
        return { state: ComputeToDataResponseState.FINISHED, data: cached };
      case ComputeToDataResultType.C2D_URI:
        let resp: string;
        if (jobIndex == 0) {
          resp = await this.nautilus.getComputeResult({
            jobId: jobId,
            providerUri: this.getSelectedNetworkConfig().providerUri,
          });
        } else {
          resp = await this.nautilus.getComputeResult({
            jobId: jobId,
            providerUri: this.getSelectedNetworkConfig().providerUri,
            resultIndex: jobIndex,
          });
        }
        this.logger.debug(`Response is ${resp}`);
        return { state: ComputeToDataResponseState.FINISHED, data: resp };
      default:
        throw new NotFoundException(`Requested method not found`);
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async __periodicallyFetchComputeJobs() {
    let pendingJobs = await this.redis.lrange(
      `${this.getSelectedNetworkConfig().network}:ctd:pending`,
      0,
      -1,
    );
    pendingJobs.forEach(async (jobId, _i, _arr) => {
      // Check if compute to data is finished
      if ((await this.getComputeToDataStatus(jobId)) != 70) {
        return;
      }

      // get compute to data result
      const ResultUrl = await this.nautilus.getComputeResult({
        jobId: jobId,
        providerUri: this.getSelectedNetworkConfig().providerUri,
      });
      const FetchedData: AxiosResponse = await axios
        .get(ResultUrl)
        .catch((error) => {
          // TODO: Add proper error handling, maybe re-try logic?
          return undefined;
        });

      // Do nothing if we cant fetch the result, maybe next iteration
      if (FetchedData === undefined) {
        return;
      }

      let b64data = '';
      switch (FetchedData.data.constructor) {
        case Object:
          b64data = Buffer.from(JSON.stringify(FetchedData.data)).toString(
            'base64',
          );
          break;
        case String:
        case Buffer:
        case ArrayBuffer:
        case Array:
        default:
          b64data = Buffer.from(FetchedData.data).toString('base64');
          break;
      }

      let redisTransaction = this.redis.multi();
      redisTransaction.set(
        `${this.getSelectedNetworkConfig().network}:ctd:result:${jobId}`,
        b64data,
      );
      redisTransaction.expire(
        `${this.getSelectedNetworkConfig().network}:ctd:result:${jobId}`,
        60 * 60,
      );
      redisTransaction.publish(
        `${this.getSelectedNetworkConfig().network}:ctd:finished`,
        jobId,
      );
      redisTransaction.lrem(
        `${this.getSelectedNetworkConfig().network}:ctd:pending`,
        1,
        jobId,
      );
      this.logger.debug(
        `Executing ${redisTransaction.length} redis commands after successful compute-to-data job`,
      );
      await redisTransaction.exec();
    });
  }
}
