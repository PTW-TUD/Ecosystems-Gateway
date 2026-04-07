import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  PricingConfigWithoutOwner,
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
  GetComputeToDataResultResponse,
  ComputeToDataResponseState,
  Pricing_PricingType,
} from '../generated/spp_v2';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service';
import { RpcException } from '@nestjs/microservices';
import { isRpcException, mapToRpcException } from '../grpc-error.util';
import { status as GrpcStatusCode, Metadata } from '@grpc/grpc-js';
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
    } catch (err: any) {
      this.logger.error(
        `publishAsset failed: ${err?.message ?? err}`,
        err?.stack,
      );
      if (isRpcException(err)) throw err;
      throw mapToRpcException(err, {
        service: 'pontusx',
        where: 'publishAsset',
      });
    } finally {
      release();
    }
  }

  async updateOffering(UpdateOffering: UpdateOfferingRequest_UpdateOffering) {
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'updateOffering');

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

      const updatedInd: Array<number> = [];

      offering.updateServices?.forEach(async (updateService) => {
        let serviceInd: number = 0;
        if (updateService.index !== undefined) {
          if (updateService.index in aquariusAsset.services) {
            serviceInd = updateService.index;
          } else {
            throw new RpcException({
              code: GrpcStatusCode.OUT_OF_RANGE,
              message: `The requested service index ${updateService.index} is out of range of the existing services of the asset`,
              metadata,
            });
          }
        }
        if (!updatedInd.includes(serviceInd)) {
          if (serviceInd === 0) {
            this.logger.debug(
              `Updating only first service of asset ${offering.did} ...`,
            );
          } else {
            this.logger.debug(
              `Updating service with index ${serviceInd} of asset ${offering.did} ...`,
            );
          }

          const serviceId = aquariusAsset.services[serviceInd].id;
          const serviceBuilder = new ServiceBuilder({
            aquariusAsset: aquariusAsset,
            serviceId: serviceId,
          });
          const NautilusService = this.buildService(
            serviceBuilder,
            offering,
            updateService.service,
          );
          filled_assetBuilder.addService(NautilusService);

          //TODO: deduplicate these checks with the ones in buildService
          if (updateService.service.pricing !== undefined) {
            const pricing: PricingConfigWithoutOwner =
              this.pricingConfig[
                pricing_PricingTypeToJSON(
                  updateService.service.pricing.pricingType,
                )
              ];
            if (pricing.type !== 'free') {
              if (
                pricing.freCreationParams.baseTokenAddress !==
                aquariusAsset.stats.price.tokenAddress
              ) {
                throw new RpcException({
                  code: GrpcStatusCode.UNIMPLEMENTED,
                  message: `Service ${serviceInd}: Payment token ${pricing_PricingTypeToJSON(updateService.service.pricing.pricingType)} differs from existing ${aquariusAsset.stats.price.tokenSymbol ?? 'free'} payment. Currently only a price value update is supported.`,
                  metadata,
                });
              } else {
                const newPrice = updateService.service.pricing.fixedRate;
                if (newPrice === 0) {
                  this.logger.warn(
                    'Price value was not set or 0 when trying to update non-free service. Skipping...',
                  );
                } else {
                  await this.nautilus.setServicePrice(
                    aquariusAsset,
                    serviceId,
                    newPrice.toString(),
                  );
                }
              }
            } else {
              await this.nautilus.setServicePrice(
                aquariusAsset,
                serviceId,
                '0.0',
              );
            }
          }
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
    } catch (err: any) {
      this.logger.error(
        `updateOffering failed: ${err?.message ?? err}`,
        err?.stack,
      );
      if (isRpcException(err)) throw err;
      throw mapToRpcException(err, {
        service: 'pontusx',
        where: 'updateOffering',
      });
    } finally {
      release();
    }
  }

  async setState(did: string, state: LifecycleStates) {
    try {
      const aquariusAsset = await this.nautilus.getAquariusAsset(did);

      const result = await this.nautilus.setAssetLifecycleState(
        aquariusAsset,
        state,
      );

      return result;
    } catch (err: any) {
      this.logger.error(`setState failed: ${err?.message ?? err}`, err?.stack);
      if (isRpcException(err)) throw err;
      throw mapToRpcException(err, { service: 'pontusx', where: 'setState' });
    }
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
          const param: ConsumerParameter = {
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
          const metadata = new Metadata();
          metadata.set('x-service', 'pontusx');
          metadata.set('x-where', 'fillAsset');
          throw new RpcException({
            code: GrpcStatusCode.INVALID_ARGUMENT,
            message: 'The message type does not fit a known Pontus-X request',
            metadata,
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
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'buildService');

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
              code: GrpcStatusCode.INVALID_ARGUMENT,
              message:
                'The message type does not fit a known Pontus-X request - when trying to resolve computeOptions.allowRawAlgorithm undefined',
              metadata,
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
              code: GrpcStatusCode.INVALID_ARGUMENT,
              message:
                'The message type does not fit a known Pontus-X request - when trying to resolve computeOptions.allowNetworkAccess undefined',
              metadata,
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
            `Compute Options are missing in service for asset ${offering.metadata.name} of type compute`,
          );
          throw new RpcException({
            code: GrpcStatusCode.INVALID_ARGUMENT,
            message: `Compute Options are missing in service for asset ${offering.metadata.name} of type compute`,
            metadata,
          });
        } else if (pxUpdateOffering) {
          this.logger.debug(
            `Not updating Compute options of service for asset ${offering.did} as they are missing in the request`,
          );
        } else {
          throw new RpcException({
            code: GrpcStatusCode.INVALID_ARGUMENT,
            message:
              'The message type does not fit a known Pontus-X request - when trying to resolve computeOptions undefined',
            metadata,
          });
        }
      }
    }
    if (pxOffering && !pxUpdateOffering) {
      if (!service.pricing) {
        service.pricing = { pricingType: Pricing_PricingType.FREE };
      }
      const pricing: PricingConfigWithoutOwner =
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
    } else if (pxUpdateOffering) {
      if (!service.pricing) {
        this.logger.debug(
          `Not updating pricing as it is missing in the request`,
        );
      }
      //pricing should be updated above with nautilus.setServicePrice
    } else {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message:
          'The message type does not fit a known Pontus-X request - when trying to resolve pricing',
        metadata,
      });
    }

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
      const param: ConsumerParameter = {
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
    return this.nautilus.getAquariusAsset(did);
  }

  async queryOfferings(
    did: string,
    name: string,
    description: string,
    author: string,
    metadataType: string,
    serviceType: string,
    page: number,
    pageSize: number,
  ): Promise<[Asset[], number]> {
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'queryOfferings');
    const apiPath = '/api/aquarius/assets/query';

    const metadataCacheUri = this.getSelectedNetworkConfig().metadataCacheUri;

    if (!metadataCacheUri) {
      throw new RpcException({
        code: GrpcStatusCode.FAILED_PRECONDITION,
        message: 'No metadata cache URI (aquarius) provided',
        metadata,
      });
    }

    const queryPayload = this.buildQueryPayload(
      did,
      name,
      description,
      author,
      metadataType,
      serviceType,
      page,
      pageSize,
    );

    const assets: Asset[] = [];
    let total = 0;
    const fullAquariusUrl = new URL(apiPath, metadataCacheUri).href;
    const response: AxiosResponse<any> = await axios.post(
      fullAquariusUrl,
      queryPayload,
    );

    if (response?.status === 200 && response?.data?.hits) {
      for (const hit of response.data.hits.hits) {
        const asset: Asset = hit._source;
        if (asset?.id) {
          assets.push(asset);
        }
      }
      total = response.data.hits.total.value;
    }
    return [assets, total];
  }

  buildQueryPayload(
    did: string,
    name: string,
    description: string,
    author: string,
    metadataType: string,
    serviceType: string,
    page: number,
    pageSize: number,
  ) {
    const attribute_queries = [];
    if (did)
      attribute_queries.push({
        query_string: {
          query: did.replace('did:op:', '*'),
          fields: [
            'id',
            'datatokens.address',
            'datatokens.name',
            'datatokens.symbol',
          ],
        },
      });
    if (name)
      attribute_queries.push({
        query_string: {
          query: name,
          fields: ['datatokens.name', 'metadata.name^10'],
        },
      });
    if (description)
      attribute_queries.push({
        query_string: {
          query: description,
          fields: ['metadata.description', 'metadata.tags'],
        },
      });
    if (author)
      attribute_queries.push({
        query_string: {
          query: author,
          fields: ['nft.owner', 'metadata.author'],
        },
      });

    if (attribute_queries.length === 0)
      attribute_queries.push({ match_all: {} });

    if (!pageSize) pageSize = 50;
    if (!metadataType) metadataType = 'dataset';
    if (!serviceType) metadataType = 'access';

    const payload = {
      from: pageSize * page,
      size: pageSize,
      query: {
        bool: {
          must: [{ bool: { should: attribute_queries } }],
          filter: [
            { terms: { chainId: [32456, 32457] } },
            { terms: { _index: ['v510'] } },
            { term: { 'purgatory.state': false } },
            {
              bool: {
                must_not: [
                  { term: { 'nft.state': 5 } },
                  { term: { 'price.type': 'pool' } },
                ],
              },
            },
            {
              term: { 'metadata.type': metadataType },
            },
            { term: { 'services.type': serviceType } },
          ],
        },
      },
      sort: { 'nft.created': 'desc' },
    };
    return payload;
  }

  async accessService(
    did: string,
    serviceId: string,
    fileIndex: number,
    userdata: { [key: string]: string },
  ): Promise<string> {
    //TODO: integrate data storage in redis as option?
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'accessService');
    let dataset: Asset;

    try {
      dataset = await this.getOffering(did);
    } catch (err) {
      throw new RpcException({
        code: GrpcStatusCode.NOT_FOUND,
        message: `Asset couldn't be retrieved: ${err}`,
        metadata,
      });
    }
    if (serviceId !== '') {
      const serviceCandidate = dataset.services?.find(
        (s) => s.type === 'access',
      );
      if (serviceCandidate) {
        serviceId = serviceCandidate.id;
      }
    } else {
      const serviceCandidate = dataset.services?.find(
        (s) => s.id === serviceId,
      );
      if (!serviceCandidate) {
        serviceId = '';
      }
    }
    if (serviceId === '') {
      throw new RpcException({
        code: GrpcStatusCode.NOT_FOUND,
        message: `No valid access service found`,
        metadata: metadata,
      });
    }
    // Check for file index is skipped as metadata only contains one big hash for all files and there seems to be no way to extract the number of files

    const release = await this.mutex.acquire();
    try {
      const uri = await this.nautilus
        .access({
          assetDid: did,
          fileIndex: fileIndex,
          serviceId: serviceId,
          userdata: userdata,
        })
        .catch((err) => {
          throw new RpcException({
            code: GrpcStatusCode.FAILED_PRECONDITION,
            message: `Couldn't get access to the asset: ${err}`,
            metadata: metadata,
          });
        });
      return uri;
      // no extra catch as we only execute one function
    } finally {
      release();
    }
  }

  async requestComputeToData(
    did: string,
    algo: string,
    userdata: { [key: string]: string },
  ): Promise<string[]> {
    const release = await this.mutex.acquire();
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'requestComputeToData');

    try {
      const computeConfig: Omit<ComputeConfig, 'signer' | 'chainConfig'> = {
        dataset: {
          did: did,
          userdata: userdata,
        },
        algorithm: { did: algo },
      };

      const dataset = await this.getOffering(computeConfig.dataset.did).catch(
        (err) => {
          throw new RpcException({
            code: GrpcStatusCode.NOT_FOUND,
            message: `Asset not found: ${err}`,
            metadata,
          });
        },
      );

      // verify that requested asset has compute jobs available
      const compute_objects = dataset.services.filter((obj) => {
        return obj.type === 'compute';
      });
      if (compute_objects.length < 1) {
        throw new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message: 'No algorithms are available',
          metadata,
        });
      }

      const computeJob = await this.nautilus
        .compute(computeConfig)
        .catch((err) => {
          throw new RpcException({
            code: GrpcStatusCode.NOT_FOUND,
            message: `Compute to Data job can't start: ${err}`,
            metadata,
          });
        });

      const jobIds = [];
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
    } catch (err: any) {
      this.logger.error(
        `requestComputeToData failed: ${err?.message ?? err}`,
        err?.stack,
      );
      if (isRpcException(err)) throw err;
      throw mapToRpcException(err, {
        service: 'pontusx',
        where: 'requestComputeToData',
      });
    } finally {
      release();
    }
  }

  async getComputeToDataStatus(jobId: string): Promise<number> {
    const status = await this.nautilus.getComputeStatus({
      jobId: jobId,
      providerUri: this.getSelectedNetworkConfig().providerUri,
    });

    if (status) {
      return status.status;
    }
    return 99;
  }

  async getComputeToDataResult(
    jobId: string,
    return_type: ComputeToDataResultType,
    jobIndex: number,
  ): Promise<GetComputeToDataResultResponse> {
    const metadata = new Metadata();
    metadata.set('x-service', 'pontusx');
    metadata.set('x-where', 'getComputeToDataResult');

    switch (return_type) {
      case ComputeToDataResultType.C2D_DATA:
        const cached = await this.redis.get(
          `${this.getSelectedNetworkConfig().network}:ctd:result:${jobId}`,
        );
        if (cached === null) {
          if ((await this.getComputeToDataStatus(jobId)) == 99) {
            throw new RpcException({
              code: GrpcStatusCode.NOT_FOUND,
              message: 'Job does not exist or is not yet finished',
            });
          }
          const queued = await this.redis.lpos(
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
        if (resp) {
          return { state: ComputeToDataResponseState.FINISHED, data: resp };
        }
        throw new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message: 'Job does not exist or is not yet finished',
          metadata,
        });
      default:
        throw new RpcException({
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message: 'Requested result type is invalid',
          metadata,
        });
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async __periodicallyFetchComputeJobs() {
    const pendingJobs = await this.redis.lrange(
      `${this.getSelectedNetworkConfig().network}:ctd:pending`,
      0,
      -1,
    );
    pendingJobs.forEach(async (jobId) => {
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
        .catch(() => {
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

      const redisTransaction = this.redis.multi();
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
