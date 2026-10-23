import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test } from '@nestjs/testing';
import { PontusxService } from './pontusx.service.js';
import { ConfigService } from '@nestjs/config';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service.js';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Mutex } from 'async-mutex';
import { LifecycleStates, PolicyDeniedError } from '@deltadao/nautilus';
import { Network, PRICING_CONFIGS, resolveNetworkConfig } from './config.js';

// the default network, without environment overrides
const NETWORK_CONFIG = resolveNetworkConfig(Network.OPSEPOLIA, () => undefined);
import { PontusxOffering, Pricing_PricingType } from '../generated/spp_v3.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const JOB = (n: string) => `0x${'a'.repeat(64)}-${n.repeat(64)}`;

// A service without its constructor: no wallet, chain, node or Redis.
function createService(nautilus: Record<string, Mock> = {}) {
  const service = Object.create(PontusxService.prototype) as PontusxService;
  Object.assign(service, {
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
    configService: { get: vi.fn() },
    networkConfig: NETWORK_CONFIG,
    pricingConfig: PRICING_CONFIGS.OPSEPOLIA,
    wallet: { getAddress: vi.fn().mockResolvedValue(OWNER) },
    remoteStore: {},
    mutex: new Mutex(),
    nautilus,
  });
  return service;
}

function datasetOffering(): PontusxOffering {
  return {
    metadata: {
      type: 'dataset',
      name: 'Dataset',
      description: 'A dataset',
      author: 'PTW',
      license: 'MIT',
      tags: ['test'],
      categories: [],
      links: {},
    },
    services: [
      {
        type: 'access',
        files: [
          { url: 'https://example.org/data.json', method: 'GET', headers: {} },
        ],
        pricing: { pricingType: Pricing_PricingType.FIXED_EURAU, price: '5' },
        consumerParameters: [
          {
            name: 'region',
            type: 'select',
            label: 'Region',
            required: false,
            description: 'Where from',
            default: 'eu',
            // as @grpc/proto-loader decodes a google.protobuf.Struct
            options: [
              {
                fields: { eu: { kind: 'stringValue', stringValue: 'Europe' } },
              },
            ] as any,
          },
          {
            name: 'rows',
            type: 'number',
            label: 'Rows',
            required: false,
            description: 'How many rows',
            default: '10',
            options: [],
          },
        ],
      },
    ],
    credentials: { allow: [], deny: [] },
    additionalInformation: {
      termsAndConditions: true,
      gaiaXInformation: {
        containsPII: false,
        termsAndConditions: [{ url: 'https://example.org/terms' }],
      } as any,
    },
  };
}

// The parts of a DDO v5 that nautilus' readers need.
function assetV5(services: object[]) {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: 'did:ope:1234',
    version: '5.0.0',
    credentialSubject: {
      id: 'did:ope:1234',
      chainId: 32456,
      nftAddress: '0x0000000000000000000000000000000000000002',
      metadata: { name: 'Dataset', type: 'dataset' },
      services,
    },
  };
}

describe('PontusxService', () => {
  const mockCesService = {
    publish: vi.fn(),
  };

  it('should be defined', async () => {
    // TODO: figure out how to test the pontusX thing
    const module = Test.createTestingModule({
      providers: [
        PontusxService,
        ConfigService,
        {
          provide: CredentialEventServiceService,
          useValue: mockCesService,
        },
      ],
    });
    expect(module).toBeDefined();
  });

  describe('publishAsset', () => {
    it('builds a DDO v5 asset and keeps it open to everyone without an allow list', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const service = createService({ publish });

      await expect(service.publishAsset(datasetOffering())).resolves.toEqual({
        ddo: { id: 'did:ope:1' },
      });

      const asset = publish.mock.calls[0][0] as any;
      expect(asset.owner).toBe(OWNER);
      expect(asset.ddo.metadata.providedBy).toBe('PTW');
      expect(asset.ddo.credentials.allow).toEqual([
        { type: 'address', values: [{ address: '*' }] },
      ]);
      expect(asset.ddo.metadata.additionalInformation).toEqual({
        termsAndConditions: true,
        gaiaXInformation:
          '{"containsPII":false,"termsAndConditions":[{"url":"https://example.org/terms"}]}',
      });

      const [nautilusService] = asset.ddo.services;
      expect(nautilusService.serviceEndpoint).toBe(
        'https://node.demo.pontus-x.eu',
      );
      expect(nautilusService.pricing.freCreationParams.fixedRate).toBe('5');
      expect(nautilusService.consumerParameters).toEqual([
        expect.objectContaining({ default: 'eu', options: [{ eu: 'Europe' }] }),
        expect.objectContaining({ name: 'rows', default: 10 }),
      ]);
      // the shared pricing configuration is not changed by a request
      expect(
        PRICING_CONFIGS.OPSEPOLIA.FIXED_EURAU.freCreationParams.fixedRate,
      ).toBe('1');
    });

    it('writes the DDO v5 metadata of the offering', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      Object.assign(offering.metadata, {
        providedBy: 'PTW TU Darmstadt',
        displayTitle: 'Machine data',
        copyrightHolder: 'TU Darmstadt',
        language: 'de',
        categories: ['manufacturing'],
        links: { website: 'https://example.org' },
      });

      await createService({ publish }).publishAsset(offering);

      const { ddo } = publish.mock.calls[0][0] as any;
      expect(ddo.metadata).toMatchObject({
        providedBy: 'PTW TU Darmstadt',
        copyrightHolder: 'TU Darmstadt',
        categories: ['manufacturing'],
        links: { website: 'https://example.org' },
      });
      expect(JSON.stringify(ddo.metadata.displayTitle)).toContain(
        'Machine data',
      );
      expect(ddo.language).toMatchObject({ language: 'de' });
    });

    it.each([
      ['FIXED_EURAU', '0.5', '0.5'],
      ['FIXED_EURAU', '12.345678', '12.345678'],
    ])('sets a %s price of %s', async (pricingType, price, fixedRate) => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.services[0].pricing = {
        pricingType: Pricing_PricingType[pricingType],
        price,
      };

      await createService({ publish }).publishAsset(offering);

      expect(
        (publish.mock.calls[0][0] as any).ddo.services[0].pricing
          .freCreationParams.fixedRate,
      ).toBe(fixedRate);
    });

    it.each([
      ['abc', 'not a positive decimal number'],
      ['0', 'not a positive decimal number'],
      ['-1', 'not a positive decimal number'],
      ['0.1234567', 'more than the 6 decimals'],
    ])('refuses the price %s', async (price, reason) => {
      const publish = vi.fn();
      const offering = datasetOffering();
      offering.services[0].pricing = {
        pricingType: Pricing_PricingType.FIXED_EURAU,
        price,
      };

      await expect(
        createService({ publish }).publishAsset(offering),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message: expect.stringContaining(reason),
        },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('refuses a payment token the network does not offer', async () => {
      const publish = vi.fn();
      const offering = datasetOffering();
      offering.services[0].pricing = {
        pricingType: Pricing_PricingType.FIXED_OCEAN,
        price: '1',
      };

      await expect(
        createService({ publish }).publishAsset(offering),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message:
            'Pricing type FIXED_OCEAN is not available on optimism_sepolia',
        },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('trusts the given algorithms and publishers of a compute service', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.services[0] = {
        ...offering.services[0],
        type: 'compute',
        consumerParameters: [],
        computeOptions: {
          trustedAlgorithms: {
            all: false,
            algorithms: [
              { did: 'did:ope:algo', serviceIds: ['compute-a'] },
              { did: 'did:ope:other', serviceIds: [] },
            ],
          },
          trustedPublishers: { all: true, addresses: [] },
        },
      };

      await createService({ publish }).publishAsset(offering);

      const [service] = (publish.mock.calls[0][0] as any).ddo.services;
      expect(service.addedPublisherTrustedAlgorithms).toEqual([
        { did: 'did:ope:algo', serviceIds: ['compute-a'] },
        { did: 'did:ope:other' },
      ]);
      expect(service.compute).toMatchObject({
        allowRawAlgorithm: false,
        allowNetworkAccess: false,
        publisherTrustedAlgorithms: [],
        publisherTrustedAlgorithmPublishers: null,
      });
    });

    it('publishes a service on the ocean-node given for it', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.services[0].serviceEndpoint = 'https://node.example.org';

      await createService({ publish }).publishAsset(offering);

      expect(
        (publish.mock.calls[0][0] as any).ddo.services[0].serviceEndpoint,
      ).toBe('https://node.example.org');
    });

    it('only allows the given addresses', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.credentials.allow = [OWNER];

      await createService({ publish }).publishAsset(offering);

      expect((publish.mock.calls[0][0] as any).ddo.credentials.allow).toEqual([
        { type: 'address', values: [{ address: OWNER }] },
      ]);
    });

    it('refuses to publish without a DDO store', async () => {
      const publish = vi.fn();
      const service = createService({ publish });
      (service as any).remoteStore = undefined;

      await expect(
        service.publishAsset(datasetOffering()),
      ).rejects.toMatchObject({
        error: { code: GrpcStatusCode.FAILED_PRECONDITION },
      });
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('updateOffering', () => {
    const BAD = '0x00000000000000000000000000000000000000bd';

    function publishedAsset() {
      const asset = assetV5([]) as any;
      asset.credentialSubject.credentials = {
        allow: [{ type: 'address', values: [{ address: '*' }] }],
        deny: [{ type: 'address', values: [BAD] }],
      };
      return asset;
    }

    async function update(credentials?: { allow: string[]; deny: string[] }) {
      const edit = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      const service = createService({
        getAsset: vi.fn().mockResolvedValue(publishedAsset()),
        edit,
      });
      await service.updateOffering({
        pontusxUpdateOffering: {
          did: 'did:ope:1234',
          updateServices: [],
          // as @grpc/proto-loader decodes an unset message field
          credentials: credentials ?? null,
        },
      } as any);
      return (edit.mock.calls[0][0] as any).ddo.credentials;
    }

    it('replaces the stored address lists with the given ones', async () => {
      const credentials = await update({ allow: [OWNER], deny: [] });

      expect(credentials.allow).toEqual([
        { type: 'address', values: [{ address: OWNER }] },
      ]);
      expect(credentials.deny).toEqual([]);
    });

    it('opens the asset to everyone again without allow addresses', async () => {
      const credentials = await update({ allow: [], deny: [OWNER] });

      expect(credentials.allow).toEqual([
        { type: 'address', values: [{ address: '*' }] },
      ]);
      expect(credentials.deny).toEqual([
        { type: 'address', values: [{ address: OWNER }] },
      ]);
    });

    it('keeps the stored lists when no credentials are given', async () => {
      expect(await update()).toEqual(
        publishedAsset().credentialSubject.credentials,
      );
    });

    const STORED_NODE = 'https://node.example.org';

    async function updateService(service: object) {
      const asset = assetV5([
        {
          id: 'access-1',
          type: 'access',
          serviceEndpoint: STORED_NODE,
          timeout: 3600,
          files: '0xencrypted',
          datatokenAddress: '0x0000000000000000000000000000000000000003',
          consumerParameters: [
            {
              name: 'rows',
              type: 'number',
              label: 'Rows',
              required: false,
              description: 'How many rows',
              default: 10,
            },
          ],
        },
      ]);
      const edit = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      const service_ = createService({
        getAsset: vi.fn().mockResolvedValue(asset),
        edit,
      });
      await service_.updateOffering({
        pontusxUpdateOffering: {
          did: 'did:ope:1234',
          updateServices: [
            // as @grpc/proto-loader decodes an unset message field
            {
              service: { type: 'access', files: [], pricing: null, ...service },
            },
          ],
          credentials: null,
        },
      } as any);
      return (edit.mock.calls[0][0] as any).ddo.services[0];
    }

    it('keeps the endpoint, files and timeout of a service it does not change', async () => {
      const service = await updateService({ name: 'Renamed' });

      expect(service).toMatchObject({
        name: 'Renamed',
        serviceEndpoint: STORED_NODE,
        serviceEndpointEdited: false,
        timeout: 3600,
      });
      expect(service.needsEncryption()).toBe(false);
    });

    it('replaces the consumer parameters of a service', async () => {
      const service = await updateService({
        consumerParameters: [
          {
            name: 'region',
            type: 'text',
            label: 'Region',
            required: true,
            description: 'Where from',
            default: 'eu',
            options: [],
          },
        ],
      });

      expect(service.consumerParameters).toEqual([
        expect.objectContaining({ name: 'region', default: 'eu' }),
      ]);
    });

    it('replaces the trusted algorithms and publishers of a compute service', async () => {
      const asset = assetV5([
        {
          id: 'compute-1',
          type: 'compute',
          serviceEndpoint: STORED_NODE,
          timeout: 3600,
          files: '0xencrypted',
          datatokenAddress: '0x0000000000000000000000000000000000000003',
          compute: {
            allowRawAlgorithm: false,
            allowNetworkAccess: true,
            publisherTrustedAlgorithms: [
              {
                did: 'did:ope:old',
                serviceId: 'compute-a',
                filesChecksum: 'a',
                containerSectionChecksum: 'b',
              },
            ],
            publisherTrustedAlgorithmPublishers: ['0xold'],
          },
        },
      ]);
      const edit = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      await createService({
        getAsset: vi.fn().mockResolvedValue(asset),
        edit,
      }).updateOffering({
        pontusxUpdateOffering: {
          did: 'did:ope:1234',
          updateServices: [
            {
              service: {
                type: 'compute',
                files: [],
                pricing: null,
                computeOptions: {
                  trustedAlgorithms: {
                    all: false,
                    algorithms: [{ did: 'did:ope:new', serviceIds: [] }],
                  },
                  trustedPublishers: { all: false, addresses: [] },
                },
              },
            },
          ],
        },
      } as any);

      const [service] = (edit.mock.calls[0][0] as any).ddo.services;
      expect(service.addedPublisherTrustedAlgorithms).toEqual([
        { did: 'did:ope:new' },
      ]);
      expect(service.compute).toMatchObject({
        // not given, so kept
        allowNetworkAccess: true,
        publisherTrustedAlgorithms: [],
        publisherTrustedAlgorithmPublishers: [],
      });
    });

    it('refuses to move a service to another ocean-node without its files', async () => {
      await expect(
        updateService({ serviceEndpoint: 'https://other-node.example.org' }),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message: expect.stringContaining('serviceEndpoint'),
        },
      });
    });
  });

  describe('queryOfferings', () => {
    it('queries the DDO v5 index page by page and reads the ocean-node answer', async () => {
      const query = vi.fn().mockResolvedValue([
        {
          results: [{ id: 'did:ope:1' }, { id: 'did:ope:2' }],
          totalResults: 7,
        },
      ]);
      const service = createService({ query });

      await expect(
        service.queryOfferings(
          'did:ope:abc',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          2,
          2,
        ),
      ).resolves.toEqual([[{ id: 'did:ope:1' }, { id: 'did:ope:2' }], 7]);

      const payload = query.mock.calls[0][0] as any;
      expect(payload).toMatchObject({ from: 3, size: 2 });
      expect(payload.query.bool.must[0].bool.should[0].query_string.query).toBe(
        '*abc',
      );
      // the fields and filters an ocean-node 4.2.2 index answers on
      expect(payload.query.bool.filter).toEqual([
        { terms: { 'credentialSubject.chainId': [11155420] } },
        { term: { 'credentialSubject.metadata.type': 'dataset' } },
        { term: { 'credentialSubject.services.type': 'access' } },
      ]);
    });

    it('searches the language-tagged description and the datatokens of DDO v5', () => {
      const payload = createService().buildQueryPayload(
        undefined,
        'sensor',
        'milling',
        undefined,
        'algorithm',
        'compute',
        undefined,
        undefined,
      );

      const fields = payload.query.bool.must[0].bool.should.flatMap(
        (clause: any) => clause.query_string.fields,
      );
      expect(fields).toEqual([
        'credentialSubject.datatokens.name',
        'credentialSubject.metadata.name^10',
        'credentialSubject.metadata.description.@value',
        'credentialSubject.metadata.tags',
      ]);
      expect(payload).toMatchObject({ from: 1, size: 50 });
      expect(payload.query.bool.filter).toContainEqual({
        term: { 'credentialSubject.services.type': 'compute' },
      });
    });

    it.each([
      [[[{ id: 'did:ope:1' }, {}]], [[{ id: 'did:ope:1' }], 2]],
      [
        {
          hits: {
            hits: [{ _source: { id: 'did:ope:1' } }],
            total: { value: 4 },
          },
        },
        [[{ id: 'did:ope:1' }], 4],
      ],
      [[], [[], 0]],
    ])('reads other answer shapes: %j', (response, expected) => {
      expect(createService().parseQueryResponse(response)).toEqual(expected);
    });
  });

  describe('accessService', () => {
    it('downloads from the first access service with typed userdata', async () => {
      const getAsset = vi.fn().mockResolvedValue(
        assetV5([
          { id: 'compute-1', type: 'compute' },
          {
            id: 'access-1',
            type: 'access',
            consumerParameters: [{ name: 'rows', type: 'number' }],
          },
        ]),
      );
      const access = vi.fn().mockResolvedValue({ url: 'https://node/dl' });
      const service = createService({ getAsset, access });

      await expect(
        service.accessService('did:ope:1234', undefined, undefined, {
          rows: '5',
          name: 'x',
        }),
      ).resolves.toBe('https://node/dl');
      expect(access).toHaveBeenCalledWith(
        expect.objectContaining({
          assetDid: 'did:ope:1234',
          serviceId: 'access-1',
          userdata: { rows: 5, name: 'x' },
        }),
      );
    });

    it('refuses a service that is not an access service', async () => {
      const getAsset = vi
        .fn()
        .mockResolvedValue(assetV5([{ id: 'compute-1', type: 'compute' }]));
      const access = vi.fn();
      const service = createService({ getAsset, access });

      await expect(
        service.accessService('did:ope:1234', 'compute-1', undefined, {}),
      ).rejects.toMatchObject({ error: { code: GrpcStatusCode.NOT_FOUND } });
      expect(access).not.toHaveBeenCalled();
    });

    function refusedAccess(err: Error) {
      const service = createService({
        getAsset: vi
          .fn()
          .mockResolvedValue(assetV5([{ id: 'access-1', type: 'access' }])),
        access: vi.fn().mockRejectedValue(err),
      });
      return service
        .accessService('did:ope:1234', undefined, undefined, {})
        .catch((rejection: RpcException) => rejection.getError() as any);
    }

    function policyDenied(params: { code?: number; policyResults?: any[] }) {
      return new PolicyDeniedError({
        nodeUri: 'https://node.example.org',
        did: 'did:ope:1234',
        serviceId: 'access-1',
        consumerAddress: OWNER,
        reason: 'Address not allowed',
        ...params,
      });
    }

    it('reports a policy server refusal as PERMISSION_DENIED', async () => {
      const error = await refusedAccess(
        policyDenied({
          policyResults: [
            { policy: 'signature', success: true },
            { policy: 'expired', success: false, error: 'Expired on …' },
          ],
        }),
      );

      expect(error).toMatchObject({
        code: GrpcStatusCode.PERMISSION_DENIED,
        message: `Access to service access-1 of did:ope:1234 denied for ${OWNER}: Address not allowed`,
      });
      expect(JSON.parse(error.details)).toEqual({
        did: 'did:ope:1234',
        serviceId: 'access-1',
        consumerAddress: OWNER,
        reason: 'Address not allowed',
        failedPolicies: ['expired'],
      });
    });

    it('reports an SSIpolicy the policy server cannot read as FAILED_PRECONDITION', async () => {
      await expect(
        refusedAccess(policyDenied({ code: 422 })),
      ).resolves.toMatchObject({ code: GrpcStatusCode.FAILED_PRECONDITION });
    });

    it('reports a service needing verifiable credentials as FAILED_PRECONDITION', async () => {
      const error = await refusedAccess(
        new Error(
          'Service access-1 of did:ope:1234 requires a verifiable presentation, and no credential provider is set to make one. Pass a WaltIdCredentialProvider as `credentials` to Nautilus.create(), or call setCredentialProvider(). Nothing was ordered or paid.',
        ),
      );

      expect(error).toMatchObject({
        code: GrpcStatusCode.FAILED_PRECONDITION,
        message:
          'Service access-1 of did:ope:1234 requires verifiable credentials, which this gateway cannot present. Nothing was ordered or paid.',
      });
    });

    it('passes on the nautilus operation id of a failed download', async () => {
      const error = await refusedAccess(
        Object.assign(new Error('order failed'), { opId: 'a1b2c3d4e5f6' }),
      );

      expect(error.code).toBe(GrpcStatusCode.FAILED_PRECONDITION);
      expect(error.metadata.get('x-nautilus-op-id')).toEqual(['a1b2c3d4e5f6']);
    });
  });

  describe('requestComputeToData', () => {
    const JOB_ID = JOB('1');

    function computeService(nautilus: Record<string, Mock>) {
      const dataset = assetV5([
        { id: 'access-1', type: 'access' },
        {
          id: 'compute-1',
          type: 'compute',
          consumerParameters: [{ name: 'rows', type: 'number' }],
        },
      ]);
      const algorithm = {
        ...assetV5([
          {
            id: 'access-a',
            type: 'access',
            consumerParameters: [{ name: 'verbose', type: 'boolean' }],
          },
        ]),
        id: 'did:ope:algo',
      } as any;
      algorithm.credentialSubject.metadata = {
        name: 'Algorithm',
        type: 'algorithm',
        algorithm: {
          consumerParameters: [{ name: 'threshold', type: 'number' }],
        },
      };
      const service = createService({
        getAsset: vi.fn(async (did: string) =>
          did === 'did:ope:algo' ? algorithm : dataset,
        ),
        ...nautilus,
      });
      (service as any).redis = { rpush: vi.fn() };
      (service as any).configService.get = vi.fn((key: string) =>
        key === 'COMPUTE_ENV' ? 'configured-env' : undefined,
      );
      return service;
    }

    const request = {
      did: 'did:ope:1234',
      userdata: { rows: '5' },
      algorithm: 'did:ope:algo',
      algorithmUserdata: { verbose: 'true' },
      algorithmParameters: { threshold: '0.5' },
      resources: [],
    };

    it('starts a paid job with typed parameters for the dataset and the algorithm', async () => {
      const compute = vi.fn().mockResolvedValue({ jobs: [{ jobId: JOB_ID }] });
      const service = computeService({ compute });

      await expect(
        service.requestComputeToData({
          ...request,
          computeEnv: 'requested-env',
          resources: [{ id: 'cpu', amount: 2 }],
          maxJobDuration: 600,
        }),
      ).resolves.toEqual([JOB_ID]);

      expect(compute).toHaveBeenCalledWith({
        dataset: {
          did: 'did:ope:1234',
          serviceId: 'compute-1',
          userdata: { rows: 5 },
        },
        algorithm: {
          did: 'did:ope:algo',
          serviceId: 'access-a',
          userdata: { verbose: true },
          algocustomdata: { threshold: 0.5 },
        },
        computeEnv: 'requested-env',
        resources: [{ id: 'cpu', amount: 2 }],
        maxJobDuration: 600,
      });
      expect((service as any).redis.rpush).toHaveBeenCalledWith(
        expect.any(String),
        JOB_ID,
      );
    });

    it('starts a free job in the configured environment', async () => {
      const freeCompute = vi
        .fn()
        .mockResolvedValue({ jobs: [{ jobId: JOB_ID }] });
      const compute = vi.fn();

      await computeService({ compute, freeCompute }).requestComputeToData({
        ...request,
        free: true,
      });

      expect(compute).not.toHaveBeenCalled();
      expect(freeCompute).toHaveBeenCalledWith(
        expect.objectContaining({
          computeEnv: 'configured-env',
          resources: undefined,
        }),
      );
      expect(freeCompute.mock.calls[0][0]).not.toHaveProperty('maxJobDuration');
    });

    it('refuses a job duration for a free job', async () => {
      await expect(
        computeService({}).requestComputeToData({
          ...request,
          free: true,
          maxJobDuration: 600,
        }),
      ).rejects.toMatchObject({
        error: { code: GrpcStatusCode.INVALID_ARGUMENT },
      });
    });

    it('refuses a dataset service that is not a compute service', async () => {
      const compute = vi.fn();

      await expect(
        computeService({ compute }).requestComputeToData({
          ...request,
          serviceId: 'access-1',
        }),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.NOT_FOUND,
          message: 'Service access-1 of did:ope:1234 is not a compute service',
        },
      });
      expect(compute).not.toHaveBeenCalled();
    });
  });

  describe('setState', () => {
    it('reports whether the lifecycle state changed', async () => {
      const asset = assetV5([]);
      const setAssetLifecycleState = vi
        .fn()
        .mockResolvedValueOnce({ hash: '0xabc' })
        .mockResolvedValueOnce(undefined);
      const service = createService({
        getAsset: vi.fn().mockResolvedValue(asset),
        setAssetLifecycleState,
      });

      await expect(
        service.setState('did:ope:1234', LifecycleStates.ASSET_UNLISTED),
      ).resolves.toEqual({
        did: 'did:ope:1234',
        state: LifecycleStates.ASSET_UNLISTED,
        changed: true,
        txHash: '0xabc',
      });
      await expect(
        service.setState('did:ope:1234', LifecycleStates.ASSET_UNLISTED),
      ).resolves.toMatchObject({ changed: false, txHash: undefined });
      expect(setAssetLifecycleState).toHaveBeenCalledWith(
        asset,
        LifecycleStates.ASSET_UNLISTED,
      );
    });
  });

  describe('getComputeToDataStatus', () => {
    let service: PontusxService;
    let getComputeStatus: Mock;

    beforeEach(() => {
      getComputeStatus = vi.fn();
      service = createService({ getComputeStatus });
    });

    it('returns the status of an existing job', async () => {
      getComputeStatus.mockResolvedValue({ status: 70 });

      await expect(service.getComputeToDataStatus(JOB('1'))).resolves.toBe(70);
      expect(getComputeStatus).toHaveBeenCalledWith({ jobId: JOB('1') });
    });

    it('returns 0 for a job that just started', async () => {
      getComputeStatus.mockResolvedValue({ status: 0 });

      await expect(service.getComputeToDataStatus(JOB('1'))).resolves.toBe(0);
    });

    it.each([undefined, null, [], {}])(
      'throws NOT_FOUND when Nautilus returns no job (%p)',
      async (status) => {
        getComputeStatus.mockResolvedValue(status);

        const result = service.getComputeToDataStatus(JOB('2'));

        await expect(result).rejects.toBeInstanceOf(RpcException);
        await expect(result).rejects.toMatchObject({
          error: {
            code: GrpcStatusCode.NOT_FOUND,
            message: `Compute job '${JOB('2')}' couldn't be found`,
          },
        });
      },
    );

    it('refuses a job id that is not an ocean-node job id', async () => {
      await expect(
        service.getComputeToDataStatus('legacy-job'),
      ).rejects.toMatchObject({
        error: { code: GrpcStatusCode.INVALID_ARGUMENT },
      });
      expect(getComputeStatus).not.toHaveBeenCalled();
    });
  });

  describe('getComputeToDataResult', () => {
    it('reports a failed job instead of queueing it', async () => {
      const service = createService({
        getComputeStatus: vi.fn().mockResolvedValue({
          status: 41,
          statusText: 'Failed to run algorithm',
          dateFinished: '2026-10-23T08:00:00Z',
        }),
      });
      const redis = {
        get: vi.fn().mockResolvedValue(null),
        rpush: vi.fn(),
      };
      (service as any).redis = redis;

      await expect(
        service.getComputeToDataResult(JOB('3'), 0, 0),
      ).rejects.toMatchObject({
        error: { code: GrpcStatusCode.FAILED_PRECONDITION },
      });
      expect(redis.rpush).not.toHaveBeenCalled();
    });
  });

  describe('__periodicallyFetchComputeJobs', () => {
    it('contains missing-job errors and checks the other jobs', async () => {
      const getComputeStatus = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ status: 40 });
      const service = createService({ getComputeStatus });
      const logger = (service as any).logger;
      (service as any).redis = {
        lrange: vi.fn().mockResolvedValue([JOB('4'), JOB('5')]),
      };

      await expect(
        service.__periodicallyFetchComputeJobs(),
      ).resolves.toBeUndefined();

      expect(getComputeStatus).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`Compute job '${JOB('4')}' couldn't be found`),
      );
    });

    it('drops failed jobs and job ids the ocean-node cannot know', async () => {
      const getComputeStatus = vi.fn().mockResolvedValue({
        status: 11,
        statusText: 'Pulling algorithm image failed',
        dateFinished: '2026-10-23T08:00:00Z',
      });
      const getComputeResult = vi.fn();
      const service = createService({ getComputeStatus, getComputeResult });
      const redis = {
        lrange: vi.fn().mockResolvedValue(['legacy-job', JOB('6')]),
        lrem: vi.fn(),
      };
      (service as any).redis = redis;

      await service.__periodicallyFetchComputeJobs();

      expect(redis.lrem).toHaveBeenCalledWith(
        'optimism_sepolia:ctd:pending',
        1,
        'legacy-job',
      );
      expect(redis.lrem).toHaveBeenCalledWith(
        'optimism_sepolia:ctd:pending',
        1,
        JOB('6'),
      );
      expect(getComputeStatus).toHaveBeenCalledTimes(1);
      expect(getComputeResult).not.toHaveBeenCalled();
    });
  });
});
