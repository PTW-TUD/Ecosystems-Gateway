import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteStore,
  EnvReader,
  Network,
  NetworkConfig,
  PRICING_CONFIGS,
  PricingConfig,
  parseTokenAmounts,
  resolveNetworkConfig,
  selectNetwork,
} from './config.js';
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  AssetBuilder,
  type AssetV5,
  type ConsumerParameterV5,
  CredentialListTypes,
  DdoValidationError,
  FileTypes,
  getAlgorithmConsumerParameters,
  formatValidationErrors,
  getDatatokenForService,
  getPricingInfo,
  getService,
  getServiceByType,
  getServices,
  LifecycleStates,
  type MetadataAlgorithmConfig,
  Nautilus,
  type NodeComputeJob,
  PolicyDeniedError,
  type PricingConfigWithoutOwner,
  type RemoteStore,
  ServiceBuilder,
  ServiceTypes,
  type UrlFileObject,
} from '@deltadao/nautilus';
import {
  ConsumerParameter,
  CreateComputeToDataRequest,
  CredentialLists,
  PontusxOffering,
  Pricing,
  pricing_PricingTypeToJSON,
  PontusxUpdateOffering,
  Service,
  UpdateOfferingRequest_UpdateOffering,
  ComputeToDataResultType,
  GetComputeToDataResultResponse,
  ComputeToDataResponseState,
  Pricing_PricingType,
} from '../generated/spp_v3.js';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service.js';
import { RpcException } from '@nestjs/microservices';
import {
  createErrorMetadata,
  formatErrorMessage,
  isRpcException,
  mapToRpcException,
} from '../grpc-error.util.js';
import { Metadata, status as GrpcStatusCode } from '@grpc/grpc-js';
import { Redis } from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios, { AxiosResponse } from 'axios';
import { Mutex } from 'async-mutex';
import {
  CTD_JOB_FINISHED,
  CTD_JOB_SETTLING,
  fromProtoStruct,
  getCredentialAddresses,
  toAdditionalInformation,
  toConsumerParameterValue,
  toUserdata,
} from './utility.js';
import { configureNautilusLogging } from './nautilus-logging.js';
import type { LogFormat } from '../logging.js';

// The `<environmentHash>-<jobId>` id ocean-node gives a compute job, as nautilus v2 requires it.
const COMPUTE_JOB_ID = /^0x[0-9a-f]{64}-[0-9a-f]{64}$/;

// nautilus refuses a service gated by an SSIpolicy when no credential provider is set, as
// here: the gateway has no wallet to present credentials from.
const PRESENTATION_REQUIRED =
  /^Service (\S+) of (\S+) requires a verifiable presentation, and no credential provider is set/;

type AlgorithmConsumerParameter = NonNullable<
  MetadataAlgorithmConfig['consumerParameters']
>[number];

@Injectable()
export class PontusxService implements OnModuleInit {
  private readonly logger = new Logger(PontusxService.name);
  private readonly selectedNetwork: Network;
  private readonly networkConfig: NetworkConfig;
  private readonly pricingConfig: PricingConfig[Network];
  private readonly wallet: Wallet;
  private readonly provider: JsonRpcProvider;
  private readonly remoteStore: RemoteStore | undefined;
  private nautilus: Nautilus;
  // there should only be one action with one private key at a time on the pontus-x network
  private mutex: Mutex;

  constructor(
    private readonly configService: ConfigService,
    private readonly credentialEventService: CredentialEventServiceService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    // as early as possible, so nautilus' own events of the setup are logged too
    const loggingProblems = configureNautilusLogging({
      level: this.configService.get<string>('NAUTILUS_LOG_LEVEL'),
      format: this.configService.get<LogFormat>('LOG_FORMAT', 'text'),
      debug: this.configService.get<string>('NAUTILUS_DEBUG'),
      debugTopics: this.configService.get<string>('NAUTILUS_DEBUG_TOPICS'),
    });
    loggingProblems.forEach((problem) => this.logger.warn(problem));

    this.selectedNetwork = selectNetwork(
      this.configService.get<string>('NETWORK'),
    );
    const env: EnvReader = (name) => this.configService.get<string>(name);
    this.networkConfig = resolveNetworkConfig(this.selectedNetwork, env);
    this.pricingConfig = PRICING_CONFIGS[this.selectedNetwork];
    this.provider = new JsonRpcProvider(this.networkConfig.nodeUri);

    this.wallet = new Wallet(
      this.configService.getOrThrow('PRIVATE_KEY'),
      this.provider,
    );
    this.remoteStore = createRemoteStore(env);

    this.mutex = new Mutex();
  }

  async onModuleInit(): Promise<void> {
    if (!this.remoteStore) {
      this.logger.warn(
        'No DDO store configured (DDO_STORE): creating and updating Pontus-X offerings is disabled.',
      );
    }

    const verificationRpcUrl = this.configService
      .get<string>('VERIFICATION_RPC_URL')
      ?.trim();
    this.nautilus = await Nautilus.create(this.wallet, {
      config: this.networkConfig,
      remoteStore: this.remoteStore,
      maxProviderFee: parseTokenAmounts(
        'MAX_PROVIDER_FEE',
        this.configService.get<string>('MAX_PROVIDER_FEE'),
      ),
      maxEscrowPayment: parseTokenAmounts(
        'MAX_ESCROW_PAYMENT',
        this.configService.get<string>('MAX_ESCROW_PAYMENT'),
      ),
      verificationProvider: verificationRpcUrl
        ? new JsonRpcProvider(verificationRpcUrl)
        : undefined,
    });
    this.logger.log(
      `Using ocean-node ${this.networkConfig.oceanNodeUri} on ${this.networkConfig.network} (chain ${this.networkConfig.chainId}) as ${this.wallet.address}`,
    );
  }

  getSelectedNetwork() {
    return this.selectedNetwork;
  }

  getSelectedNetworkConfig() {
    return this.networkConfig;
  }

  async publishAsset(offering: PontusxOffering) {
    this.assertRemoteStore('publishAsset');

    const release = await this.mutex.acquire();
    try {
      const owner = await this.wallet.getAddress();

      const asset = this.buildRequest('publishAsset', () => {
        const assetBuilder = new AssetBuilder();

        const filled_assetBuilder = this.fillAsset(assetBuilder, offering);
        filled_assetBuilder.setOwner(owner);
        this.setCredentialAddresses(filled_assetBuilder, offering.credentials);

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

          filled_assetBuilder.addService(NautilusService);
        }

        return filled_assetBuilder.build();
      });

      const result = await this.nautilus.publish(asset);
      return result;
    } catch (err: any) {
      throw this.toRpcException(err, 'publishAsset');
    } finally {
      release();
    }
  }

  async updateOffering(UpdateOffering: UpdateOfferingRequest_UpdateOffering) {
    const metadata = createErrorMetadata('pontusx', 'updateOffering');
    this.assertRemoteStore('updateOffering');

    const release = await this.mutex.acquire();
    try {
      const offering = UpdateOffering.pontusxUpdateOffering;
      const asset = await this.nautilus.getAsset(offering.did);
      const services = getServices(asset);

      const filled_assetBuilder = new AssetBuilder(asset);
      if (offering.metadata !== undefined) {
        this.logger.debug('Updating metadata of Pontus-X asset');
        this.buildRequest('updateOffering', () =>
          this.fillAsset(filled_assetBuilder, offering),
        );
      }
      // proto-loader decodes an unset message field as null
      if (offering.credentials != null) {
        this.logger.debug('Replacing the address lists of Pontus-X asset');
        this.buildRequest('updateOffering', () =>
          this.setCredentialAddresses(
            filled_assetBuilder,
            offering.credentials,
            asset,
          ),
        );
      }

      const updatedInd: Array<number> = [];
      // Prices are set on the exchange after the metadata edit went through.
      const priceUpdates: { serviceId: string; price: string }[] = [];

      for (const updateService of offering.updateServices ?? []) {
        let serviceInd: number = 0;
        if (updateService.index !== undefined) {
          if (updateService.index in services) {
            serviceInd = updateService.index;
          } else {
            throw new RpcException({
              code: GrpcStatusCode.OUT_OF_RANGE,
              message: `The requested service index ${updateService.index} is out of range of the existing services of the asset`,
              metadata,
            });
          }
        }
        if (updatedInd.includes(serviceInd)) {
          this.logger.warn(
            `Skipping repeated update of service with index ${serviceInd}`,
          );
          continue;
        }
        if (serviceInd === 0) {
          this.logger.debug(
            `Updating only first service of asset ${offering.did} ...`,
          );
        } else {
          this.logger.debug(
            `Updating service with index ${serviceInd} of asset ${offering.did} ...`,
          );
        }

        const serviceId = services[serviceInd].id;
        const NautilusService = this.buildRequest('updateOffering', () =>
          this.buildService(
            new ServiceBuilder({ asset, serviceId }),
            offering,
            updateService.service,
            services[serviceInd],
          ),
        );
        filled_assetBuilder.addService(NautilusService);

        // an unset message field is decoded as null
        if (updateService.service.pricing != null) {
          const price = await this.getPriceUpdate(
            asset,
            serviceId,
            serviceInd,
            updateService.service.pricing,
            metadata,
          );
          if (price !== undefined) priceUpdates.push({ serviceId, price });
        }
        updatedInd.push(serviceInd);
      }

      const result = await this.nautilus.edit(
        this.buildRequest('updateOffering', () => filled_assetBuilder.build()),
      );

      for (const { serviceId, price } of priceUpdates) {
        await this.nautilus.setServicePrice(asset, serviceId, price);
      }

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
      throw this.toRpcException(err, 'updateOffering');
    } finally {
      release();
    }
  }

  // The new price of an existing service, or `undefined` if there is nothing to change.
  // Changing the payment token is not supported: it needs a new datatoken.
  private async getPriceUpdate(
    asset: AssetV5,
    serviceId: string,
    serviceInd: number,
    pricing: Pricing,
    metadata: Metadata,
  ): Promise<string | undefined> {
    const pricingType = pricing_PricingTypeToJSON(pricing.pricingType);
    const requested = this.getPricing(pricingType, metadata);

    const datatoken = getDatatokenForService(asset, serviceId);
    if (!datatoken) {
      throw new RpcException({
        code: GrpcStatusCode.FAILED_PRECONDITION,
        message: `Service ${serviceInd}: could not determine its datatoken`,
        metadata,
      });
    }
    const current = await getPricingInfo(
      this.wallet,
      datatoken,
      this.nautilus.getOceanConfig(),
    );

    if (requested.type === 'free') {
      // A fixed-rate service cannot become free; it is set to a price of 0 instead.
      return current.schema === 'fixed' ? '0' : undefined;
    }
    if (
      current.schema !== 'fixed' ||
      current.baseTokenAddress?.toLowerCase() !==
        requested.freCreationParams.baseTokenAddress.toLowerCase()
    ) {
      throw new RpcException({
        code: GrpcStatusCode.UNIMPLEMENTED,
        message: `Service ${serviceInd}: Payment token ${pricingType} differs from existing ${current.schema === 'fixed' ? current.baseTokenAddress : current.schema} payment. Currently only a price value update is supported.`,
        metadata,
      });
    }
    const price = this.toPrice(
      pricing.price,
      requested.freCreationParams.baseTokenDecimals,
      metadata,
    );
    if (!price) {
      this.logger.warn(
        `Service ${serviceInd}: no price given for its ${pricingType} pricing, keeping the current one`,
      );
    }
    return price;
  }

  /**
   * A fixed-rate price as the decimal string nautilus takes, or `undefined` if none is given.
   * Refuses more decimals than the payment token has, which the chain would round away.
   */
  private toPrice(
    price: string | undefined,
    decimals: number,
    metadata: Metadata,
  ): string | undefined {
    const value = price?.trim();
    if (!value) return undefined;
    if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0)) {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: `Price '${price}' is not a positive decimal number, e.g. "0.5"`,
        metadata,
      });
    }
    if ((value.split('.')[1] ?? '').length > decimals) {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: `Price '${price}' has more than the ${decimals} decimals of its payment token`,
        metadata,
      });
    }
    return value;
  }

  async setState(did: string, state: LifecycleStates) {
    try {
      const asset = await this.nautilus.getAsset(did);

      const receipt = await this.nautilus.setAssetLifecycleState(asset, state);

      // `undefined` when the asset already is in that state
      return {
        did,
        state,
        changed: receipt !== undefined,
        txHash: receipt?.hash,
      };
    } catch (err: any) {
      throw this.toRpcException(err, 'setState');
    }
  }

  fillAsset(
    assetBuilder: AssetBuilder,
    offering: PontusxOffering | PontusxUpdateOffering,
  ) {
    const assetType = <'dataset' | 'algorithm'>offering.metadata.type;
    const { language, displayTitle, copyrightHolder, categories, links } =
      offering.metadata;
    // first, as DDO v5 tags the description with the content language
    if (language?.trim()) {
      assetBuilder.setContentLanguage(language.trim());
    }
    assetBuilder
      .setType(assetType)
      .setName(offering.metadata.name)
      .setDescription(offering.metadata.description)
      .setAuthor(offering.metadata.author)
      // required by DDO v5
      .setProvidedBy(
        offering.metadata.providedBy?.trim() ||
          this.configService.get<string>('PROVIDED_BY') ||
          offering.metadata.author,
      )
      .setLicense(offering.metadata.license)
      .addTags(offering.metadata.tags ?? []);
    if (displayTitle?.trim()) {
      assetBuilder.setDisplayTitle(displayTitle.trim());
    }
    if (copyrightHolder?.trim()) {
      assetBuilder.setCopyrightHolder(copyrightHolder.trim());
    }
    if (categories?.length) {
      assetBuilder.addCategories(categories);
    }
    if (links && Object.keys(links).length) {
      assetBuilder.addLinks(links);
    }

    if (offering.additionalInformation) {
      assetBuilder.addAdditionalInformation(
        toAdditionalInformation(offering.additionalInformation),
      );
    }

    if (assetType === 'algorithm') {
      if (offering.metadata.algorithm !== undefined) {
        const algo: MetadataAlgorithmConfig = {
          container: offering.metadata.algorithm.container,
        };
        if (offering.metadata.algorithm.language !== undefined) {
          algo.language = offering.metadata.algorithm.language;
        }
        if (offering.metadata.algorithm.version !== undefined) {
          algo.version = offering.metadata.algorithm.version;
        }
        const consumerParameters = (
          offering.metadata.algorithm.consumerParameters ?? []
        ).map((par) => this.toAlgorithmConsumerParameter(par));
        if (consumerParameters.length) {
          algo.consumerParameters = consumerParameters;
        }
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
          const metadata = createErrorMetadata('pontusx', 'fillAsset');
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

  // @grpc/proto-loader leaves unset `optional` fields out, so only the fields each request
  // always has tell them apart: an update without metadata is still an update.
  isPontusxOffering(message: any): message is PontusxOffering {
    return 'services' in message && !('updateServices' in message);
  }
  isPontusxUpdateOffering(message: any): message is PontusxUpdateOffering {
    return 'did' in message && 'updateServices' in message;
  }

  buildService(
    serviceBuilder: ServiceBuilder<ServiceTypes, FileTypes>,
    offering: PontusxOffering | PontusxUpdateOffering,
    service: Service,
    /** The published service an update changes. */
    stored?: { serviceEndpoint: string },
  ) {
    const metadata = createErrorMetadata('pontusx', 'buildService');

    // A service's files are encrypted for the ocean-node in its serviceEndpoint. Setting the
    // endpoint of a published service makes nautilus re-encrypt them, which needs them again
    // and gives the service a new id, so an update sets it only when it changes.
    const endpoint = service.serviceEndpoint?.trim();
    if (!stored) {
      serviceBuilder.setServiceEndpoint(
        endpoint || this.networkConfig.oceanNodeUri,
      );
    } else if (endpoint && endpoint !== stored.serviceEndpoint) {
      if (!service.files?.length) {
        throw new RpcException({
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message: `The serviceEndpoint of a published service can only change together with its files, which are encrypted for that ocean-node`,
          metadata,
        });
      }
      serviceBuilder.setServiceEndpoint(endpoint);
    }
    if (!stored || service.timeout !== undefined) {
      serviceBuilder.setTimeout(service.timeout ?? 86400);
    }

    if (service.name !== undefined) {
      serviceBuilder.setName(service.name);
    }
    if (service.description !== undefined) {
      serviceBuilder.setDescription(service.description);
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
        // Given lists replace the stored ones. nautilus resolves the checksums of trusted
        // algorithms from their published DDOs.
        const algorithms = service.computeOptions.trustedAlgorithms;
        if (algorithms?.all) {
          serviceBuilder.setAllAlgorithmsTrusted();
        } else if (algorithms) {
          serviceBuilder.setAllAlgorithmsUntrusted();
          if (algorithms.algorithms?.length) {
            serviceBuilder.addTrustedAlgorithms(
              algorithms.algorithms.map(({ did, serviceIds }) => ({
                did,
                ...(serviceIds?.length ? { serviceIds } : {}),
              })),
            );
          }
        }
        const publishers = service.computeOptions.trustedPublishers;
        if (publishers?.all) {
          serviceBuilder.setAllAlgorithmPublishersTrusted();
        } else if (publishers) {
          serviceBuilder.setAllAlgorithmPublishersUntrusted();
          publishers.addresses?.forEach((address) =>
            serviceBuilder.addTrustedAlgorithmPublisher(address),
          );
        }
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
      const pricingType = pricing_PricingTypeToJSON(
        service.pricing?.pricingType ?? Pricing_PricingType.FREE,
      );
      // copy, so a request's price does not stick to the shared pricing configuration
      const pricing = structuredClone(this.getPricing(pricingType, metadata));
      if (pricing.type !== 'free') {
        const price = this.toPrice(
          service.pricing?.price,
          pricing.freCreationParams.baseTokenDecimals,
          metadata,
        );
        if (price) pricing.freCreationParams.fixedRate = price;
        this.logger.debug(
          `Setting ${pricingType} pricing with fixed Rate ${pricing.freCreationParams.fixedRate}`,
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
      //pricing is updated in updateOffering with nautilus.setServicePrice
    } else {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message:
          'The message type does not fit a known Pontus-X request - when trying to resolve pricing',
        metadata,
      });
    }

    service.files?.forEach((file) => {
      const urlFile: UrlFileObject = {
        type: 'url',
        url: file.url,
        method: file.method,
      };
      if (file.headers && Object.keys(file.headers).length) {
        this.logger.debug(
          `Setting file headers: ${Object.keys(file.headers).join(', ')}`,
        );
        urlFile.headers = file.headers;
      }
      serviceBuilder.addFile(urlFile);
    });

    const parameters = (service.consumerParameters ?? []).map((par) =>
      this.toServiceConsumerParameter(par),
    );
    if (!stored) {
      parameters.forEach((par) => serviceBuilder.addConsumerParameter(par));
    }

    const NautilusService = serviceBuilder.build();
    // The builder adds to the parameters of the published service; given ones replace them.
    if (stored && parameters.length) {
      NautilusService.consumerParameters = parameters;
    }

    return NautilusService;
  }

  private getPricing(
    pricingType: string,
    metadata: Metadata,
  ): PricingConfigWithoutOwner {
    const pricing = this.pricingConfig[pricingType];
    if (!pricing) {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: `Pricing type ${pricingType} is not available on ${this.networkConfig.network}`,
        metadata,
      });
    }
    return pricing;
  }

  // DDO v5 service consumer parameters keep the type of the default and take the options as
  // a list of objects.
  private toServiceConsumerParameter(
    par: ConsumerParameter,
  ): ConsumerParameterV5 {
    const param: ConsumerParameterV5 = {
      type: par.type,
      name: par.name, // link to your file or api
      label: par.label,
      required: par.required,
      default: toConsumerParameterValue(par.type, par.default ?? ''),
      description: par.description,
    };
    if (par.options?.length) {
      param.options = par.options.map(
        fromProtoStruct,
      ) as ConsumerParameterV5['options'];
    }
    return param;
  }

  // Algorithm metadata keeps the DDO v4 consumer parameter shape: string default, options as
  // a JSON string.
  private toAlgorithmConsumerParameter(
    par: ConsumerParameter,
  ): AlgorithmConsumerParameter {
    const param: AlgorithmConsumerParameter = {
      type: par.type as AlgorithmConsumerParameter['type'],
      name: par.name,
      label: par.label,
      required: par.required,
      default: par.default,
      description: par.description,
    };
    if (par.options?.length) {
      param.options = JSON.stringify(par.options.map(fromProtoStruct));
    }
    return param;
  }

  async getOffering(did: string): Promise<AssetV5> {
    return this.nautilus.getAsset(did);
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
  ): Promise<[AssetV5[], number]> {
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

    return this.parseQueryResponse(await this.nautilus.query(queryPayload));
  }

  // ocean-node answers with one entry per index it searched: `{ results, totalResults }`
  // (OceanProtocolEnterprise ocean-node) or the bare list of documents. The Aquarius shape is
  // kept for nodes that still answer with the raw Elasticsearch response.
  parseQueryResponse(response: unknown): [AssetV5[], number] {
    const assets: AssetV5[] = [];
    let total = 0;

    if (Array.isArray(response)) {
      for (const entry of response) {
        if (Array.isArray(entry)) {
          assets.push(...entry);
          total += entry.length;
        } else if (Array.isArray(entry?.results)) {
          assets.push(...entry.results);
          total += entry.totalResults ?? entry.results.length;
        }
      }
    } else {
      const hits = (response as any)?.hits;
      for (const hit of hits?.hits ?? []) {
        assets.push(hit._source);
      }
      total = hits?.total?.value ?? hits?.total ?? assets.length;
    }

    return [assets.filter((asset) => asset?.id), total];
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
    // DDO v5 index: the document, datatokens included, lives under credentialSubject, the
    // indexer's data under indexedMetadata. DIDs are did:ope: now. The field names are
    // checked against an OceanProtocolEnterprise ocean-node 4.2.2.
    const attribute_queries = [];
    if (did)
      attribute_queries.push({
        query_string: {
          query: did.replace(/^did:ope?:/, '*'),
          fields: [
            'id',
            'credentialSubject.nftAddress',
            'credentialSubject.datatokens.address',
            'credentialSubject.datatokens.name',
            'credentialSubject.datatokens.symbol',
          ],
        },
      });
    if (name)
      attribute_queries.push({
        query_string: {
          query: name,
          fields: [
            'credentialSubject.datatokens.name',
            'credentialSubject.metadata.name^10',
          ],
        },
      });
    if (description)
      attribute_queries.push({
        query_string: {
          query: description,
          fields: [
            // a language-tagged value in DDO v5
            'credentialSubject.metadata.description.@value',
            'credentialSubject.metadata.tags',
          ],
        },
      });
    if (author)
      attribute_queries.push({
        query_string: {
          query: author,
          fields: [
            'indexedMetadata.nft.owner',
            'credentialSubject.metadata.author',
          ],
        },
      });

    if (attribute_queries.length === 0)
      attribute_queries.push({ match_all: {} });

    if (!pageSize) pageSize = 50;
    if (!metadataType) metadataType = 'dataset';
    if (!serviceType) serviceType = 'access';

    const payload = {
      // ocean-node reads `from` as the 1-based page number, not as an offset
      from: (page ?? 0) + 1,
      size: pageSize,
      query: {
        bool: {
          must: [{ bool: { should: attribute_queries } }],
          filter: [
            {
              terms: {
                // the chain the gateway publishes and consumes on
                'credentialSubject.chainId': [this.networkConfig.chainId],
              },
            },
            {
              term: { 'credentialSubject.metadata.type': metadataType },
            },
            // Not a nested query: ocean-node does not map the services as nested, and
            // answers one with no results at all.
            {
              term: { 'credentialSubject.services.type': serviceType },
            },
          ],
          must_not: [
            { term: { 'indexedMetadata.purgatory.state': true } },
            {
              term: {
                'indexedMetadata.nft.state': LifecycleStates.ASSET_UNLISTED,
              },
            },
          ],
        },
      },
      sort: { 'credentialSubject.metadata.created': 'desc' },
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
    const metadata = createErrorMetadata('pontusx', 'accessService');
    let dataset: AssetV5;

    try {
      dataset = await this.getOffering(did);
    } catch (err) {
      throw new RpcException({
        code: GrpcStatusCode.NOT_FOUND,
        message: `Asset couldn't be retrieved: ${formatErrorMessage(err)}`,
        metadata,
      });
    }
    // the requested service, else the first access service
    const service = serviceId
      ? getService(dataset, serviceId)
      : getServiceByType(dataset, 'access');
    if (service?.type !== 'access') {
      throw new RpcException({
        code: GrpcStatusCode.NOT_FOUND,
        message: `No valid access service found`,
        metadata: metadata,
      });
    }
    // Check for file index is skipped as metadata only contains one big hash for all files and there seems to be no way to extract the number of files

    const release = await this.mutex.acquire();
    try {
      const { url } = await this.nautilus
        .access({
          assetDid: did,
          fileIndex: fileIndex,
          serviceId: service.id,
          userdata: toUserdata(userdata, service.consumerParameters),
        })
        .catch((err) => {
          throw this.toRpcException(
            err,
            'accessService',
            GrpcStatusCode.FAILED_PRECONDITION,
          );
        });
      return url;
      // no extra catch as we only execute one function
    } finally {
      release();
    }
  }

  async requestComputeToData(
    request: CreateComputeToDataRequest,
  ): Promise<string[]> {
    const metadata = createErrorMetadata('pontusx', 'requestComputeToData');
    if (request.free && request.maxJobDuration !== undefined) {
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message:
          "A free compute job runs within the environment's free limits: maxJobDuration cannot be set",
        metadata,
      });
    }

    const release = await this.mutex.acquire();
    try {
      const dataset = await this.getOffering(request.did).catch((err) => {
        throw new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message: `Asset not found: ${formatErrorMessage(err)}`,
          metadata,
        });
      });
      // the requested compute service, else the first one
      const computeService = request.serviceId
        ? getService(dataset, request.serviceId)
        : getServiceByType(dataset, 'compute');
      if (computeService?.type !== 'compute') {
        throw new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message: request.serviceId
            ? `Service ${request.serviceId} of ${request.did} is not a compute service`
            : `${request.did} has no compute service`,
          metadata,
        });
      }

      // The algorithm's DDO declares the types its parameter values are converted to.
      const algorithm = await this.getOffering(request.algorithm).catch(
        (err) => {
          throw new RpcException({
            code: GrpcStatusCode.NOT_FOUND,
            message: `Algorithm not found: ${formatErrorMessage(err)}`,
            metadata,
          });
        },
      );
      // as nautilus chooses it: the requested service, else the compute one, else the first
      const algorithmService = request.algorithmServiceId
        ? getService(algorithm, request.algorithmServiceId)
        : (getServiceByType(algorithm, 'compute') ?? getServices(algorithm)[0]);
      if (!algorithmService) {
        throw new RpcException({
          code: GrpcStatusCode.NOT_FOUND,
          message:
            `Algorithm ${request.algorithm} has no service ${request.algorithmServiceId ?? ''}`.trim(),
          metadata,
        });
      }

      const config = {
        dataset: {
          did: request.did,
          serviceId: computeService.id,
          userdata: toUserdata(
            request.userdata,
            computeService.consumerParameters,
          ),
        },
        algorithm: {
          did: request.algorithm,
          serviceId: algorithmService.id,
          userdata: toUserdata(
            request.algorithmUserdata,
            algorithmService.consumerParameters,
          ),
          algocustomdata: toUserdata(
            request.algorithmParameters,
            getAlgorithmConsumerParameters(algorithm),
          ),
        },
        // the node's first environment, unless one is requested or configured
        computeEnv:
          request.computeEnv?.trim() ||
          this.configService.get<string>('COMPUTE_ENV')?.trim() ||
          undefined,
        // the environment's minimum of each, unless resources are requested
        resources: request.resources?.length
          ? request.resources.map(({ id, amount }) => ({ id, amount }))
          : undefined,
      };
      const computeJob = await (
        request.free
          ? this.nautilus.freeCompute(config)
          : this.nautilus.compute({
              ...config,
              maxJobDuration: request.maxJobDuration,
            })
      ).catch((err) => {
        throw this.toRpcException(
          err,
          'requestComputeToData',
          GrpcStatusCode.NOT_FOUND,
        );
      });

      const jobIds = computeJob.jobs.map((job) => job.jobId);
      if (jobIds.length) {
        await this.redis.rpush(this.pendingJobsKey(), ...jobIds);
      }

      return jobIds;
    } catch (err: any) {
      throw this.toRpcException(err, 'requestComputeToData');
    } finally {
      release();
    }
  }

  private async getComputeJob(jobId: string): Promise<NodeComputeJob> {
    const metadata = createErrorMetadata('pontusx', 'getComputeToDataStatus');

    this.assertComputeJobId(jobId, metadata);
    const job = await this.nautilus.getComputeStatus({ jobId: jobId });

    if (job?.status !== undefined) {
      return job;
    }

    throw new RpcException({
      code: GrpcStatusCode.NOT_FOUND,
      message: `Compute job '${jobId}' couldn't be found`,
      metadata,
    });
  }

  async getComputeToDataStatus(jobId: string): Promise<number> {
    return (await this.getComputeJob(jobId)).status;
  }

  async getComputeToDataResult(
    jobId: string,
    return_type: ComputeToDataResultType,
    jobIndex: number,
  ): Promise<GetComputeToDataResultResponse> {
    const metadata = createErrorMetadata('pontusx', 'getComputeToDataResult');

    switch (return_type) {
      case ComputeToDataResultType.C2D_DATA:
        const cached = await this.redis.get(this.resultKey(jobId));
        if (cached === null) {
          const job = await this.getComputeJob(jobId);
          if (this.isFailedJob(job)) {
            throw new RpcException({
              code: GrpcStatusCode.FAILED_PRECONDITION,
              message: `Compute job '${jobId}' ended without a result: ${job.status} (${job.statusText})`,
              metadata,
            });
          }
          const queued = await this.redis.lpos(this.pendingJobsKey(), jobId);
          if (queued != null) {
            return {
              state: ComputeToDataResponseState.IN_PROGRESS,
              data: 'Data has been queued, processing started',
            };
          }

          await this.redis.rpush(this.pendingJobsKey(), jobId);
          return {
            state: ComputeToDataResponseState.QUEUED,
            data: 'Data has been queued, waiting to be processed',
          };
        }
        return { state: ComputeToDataResponseState.FINISHED, data: cached };
      case ComputeToDataResultType.C2D_URI:
        this.assertComputeJobId(jobId, metadata);
        // by default the job's output (outputs.tar)
        const resp = await this.nautilus.getComputeResult({
          jobId: jobId,
          ...(jobIndex ? { resultIndex: jobIndex } : {}),
        });
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
    const pendingJobs = await this.redis.lrange(this.pendingJobsKey(), 0, -1);
    await Promise.all(
      pendingJobs.map(async (jobId) => {
        try {
          // e.g. job ids of nautilus v1, which the ocean-node does not know
          if (!COMPUTE_JOB_ID.test(jobId)) {
            this.logger.warn(
              `Dropping compute-to-data job '${jobId}': not an ocean-node job id`,
            );
            await this.redis.lrem(this.pendingJobsKey(), 1, jobId);
            return;
          }

          // A job is done once it has a finish date, whether it succeeded or not
          const job = await this.getComputeJob(jobId);
          if (!job.dateFinished) {
            return;
          }
          if (this.isFailedJob(job)) {
            this.logger.warn(
              `Compute-to-data job '${jobId}' ended without a result: ${job.status} (${job.statusText})`,
            );
            await this.redis.lrem(this.pendingJobsKey(), 1, jobId);
            return;
          }

          // get compute to data result, the job's outputs.tar
          const ResultUrl = await this.nautilus.getComputeResult({
            jobId: jobId,
          });
          // the output is not listed yet, maybe next iteration
          if (!ResultUrl) {
            return;
          }
          let FetchedData: AxiosResponse<ArrayBuffer> | undefined;
          const maxAttempts = 3;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              FetchedData = await axios.get(ResultUrl, {
                timeout: 5000,
                responseType: 'arraybuffer',
              });
              break;
            } catch (err) {
              const status = axios.isAxiosError(err)
                ? err.response?.status
                : undefined;
              const retryable =
                axios.isAxiosError(err) &&
                !axios.isCancel(err) &&
                (status === undefined ||
                  status === 408 ||
                  status === 429 ||
                  status >= 500);
              this.logger.warn(
                `Could not fetch compute-to-data result for job '${jobId}' (attempt ${attempt}/${maxAttempts}): ${formatErrorMessage(err)}`,
              );
              if (!retryable || attempt === maxAttempts) {
                break;
              }
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * 2 ** (attempt - 1)),
              );
            }
          }

          // Do nothing if we cant fetch the result, maybe next iteration
          if (FetchedData === undefined) {
            return;
          }

          const b64data = Buffer.from(FetchedData.data).toString('base64');

          const redisTransaction = this.redis.multi();
          redisTransaction.set(this.resultKey(jobId), b64data);
          redisTransaction.expire(this.resultKey(jobId), 60 * 60);
          redisTransaction.publish(
            `${this.getSelectedNetworkConfig().network}:ctd:finished`,
            jobId,
          );
          redisTransaction.lrem(this.pendingJobsKey(), 1, jobId);
          this.logger.debug(
            `Executing ${redisTransaction.length} redis commands after successful compute-to-data job`,
          );
          await redisTransaction.exec();
        } catch (err) {
          this.logger.warn(
            `Could not process compute-to-data job '${jobId}': ${formatErrorMessage(err)}`,
          );
        }
      }),
    );
  }

  private pendingJobsKey() {
    return `${this.getSelectedNetworkConfig().network}:ctd:pending`;
  }

  private resultKey(jobId: string) {
    return `${this.getSelectedNetworkConfig().network}:ctd:result:${jobId}`;
  }

  // Finished jobs that failed end below 70; 71 is set before the outputs are written.
  private isFailedJob(job: NodeComputeJob) {
    return (
      Boolean(job.dateFinished) &&
      job.status !== CTD_JOB_FINISHED &&
      job.status !== CTD_JOB_SETTLING
    );
  }

  private assertComputeJobId(jobId: string, metadata: Metadata) {
    if (COMPUTE_JOB_ID.test(jobId)) return;
    throw new RpcException({
      code: GrpcStatusCode.INVALID_ARGUMENT,
      message: `Compute job id '${jobId}' is not in the form <environmentHash>-<jobId> returned when the job was started`,
      metadata,
    });
  }

  /**
   * Replaces the asset's address allow and deny lists with the given ones; access lists and
   * SSI policies set elsewhere are kept. In nautilus v2 an empty or missing allow list
   * denies everyone, so without allow addresses the asset is open to everyone, as in v1.
   */
  private setCredentialAddresses(
    assetBuilder: AssetBuilder,
    credentials: CredentialLists | undefined,
    asset?: AssetV5,
  ) {
    for (const list of [CredentialListTypes.ALLOW, CredentialListTypes.DENY]) {
      const stored = asset ? getCredentialAddresses(asset, list) : [];
      if (stored.length) assetBuilder.removeCredentialAddresses(list, stored);
    }
    assetBuilder.addCredentialAddresses(
      CredentialListTypes.ALLOW,
      credentials?.allow?.length ? credentials.allow : ['*'],
    );
    if (credentials?.deny?.length) {
      assetBuilder.addCredentialAddresses(
        CredentialListTypes.DENY,
        credentials.deny,
      );
    }
  }

  // The builders check the request before anything is sent, so their errors are the caller's.
  private buildRequest<T>(where: string, build: () => T): T {
    try {
      return build();
    } catch (err) {
      if (isRpcException(err)) throw err;
      throw new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: formatErrorMessage(err),
        metadata: createErrorMetadata('pontusx', where),
      });
    }
  }

  private assertRemoteStore(where: string) {
    if (this.remoteStore) return;
    throw new RpcException({
      code: GrpcStatusCode.FAILED_PRECONDITION,
      message:
        'Creating and updating Pontus-X offerings needs a DDO store: set DDO_STORE (ipfs or s3) and its settings',
      metadata: createErrorMetadata('pontusx', where),
    });
  }

  /** `defaultCode`: for an error that is neither a policy refusal nor an HTTP answer. */
  private toRpcException(
    err: any,
    where: string,
    defaultCode?: GrpcStatusCode,
  ): RpcException {
    const exception = this.toRpcExceptionWithoutOpId(err, where, defaultCode);
    // nautilus tags its errors with the id of the operation its log lines carry
    const metadata = exception.getError()?.['metadata'];
    if (typeof err?.opId === 'string' && metadata instanceof Metadata) {
      metadata.set('x-nautilus-op-id', err.opId);
    }
    return exception;
  }

  private toRpcExceptionWithoutOpId(
    err: any,
    where: string,
    defaultCode?: GrpcStatusCode,
  ): RpcException {
    if (isRpcException(err)) return err;
    // nautilus validates the DDO locally before any transaction
    if (err instanceof DdoValidationError) {
      return new RpcException({
        code: GrpcStatusCode.INVALID_ARGUMENT,
        message: `DDO validation failed: ${formatValidationErrors(err.errors)}`,
        details: JSON.stringify(
          Object.fromEntries(
            Object.entries(err.errors).filter(([key]) => key !== 'fullReport'),
          ),
        ),
        metadata: createErrorMetadata('pontusx', where),
      });
    }
    // The policy server refused the consumer, before anything was ordered or paid.
    if (err instanceof PolicyDeniedError) {
      return new RpcException({
        // 422: the asset's SSIpolicy cannot be read, which only its publisher can fix
        code:
          err.code === 422
            ? GrpcStatusCode.FAILED_PRECONDITION
            : GrpcStatusCode.PERMISSION_DENIED,
        message: `Access to service ${err.serviceId} of ${err.did} denied for ${err.consumerAddress}: ${err.reason}`,
        details: JSON.stringify({
          did: err.did,
          serviceId: err.serviceId,
          consumerAddress: err.consumerAddress,
          status: err.code,
          reason: err.reason,
          // Only the names: a policy's error can quote the presented credential.
          failedPolicies: err.policyResults
            ?.filter((result) => !result.success)
            .map((result) => result.policy),
        }),
        metadata: createErrorMetadata('pontusx', where),
      });
    }
    const presentation = PRESENTATION_REQUIRED.exec(err?.message ?? '');
    if (presentation) {
      return new RpcException({
        code: GrpcStatusCode.FAILED_PRECONDITION,
        message: `Service ${presentation[1]} of ${presentation[2]} requires verifiable credentials, which this gateway cannot present. Nothing was ordered or paid.`,
        metadata: createErrorMetadata('pontusx', where),
      });
    }
    return mapToRpcException(err, { service: 'pontusx', where, defaultCode });
  }
}
