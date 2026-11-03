import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test } from '@nestjs/testing';
import { PontusxService } from './pontusx.service.js';
import { ConfigService } from '@nestjs/config';
import { CredentialEventServiceService } from '../credential-event-service/credential-event-service.service.js';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Mutex } from 'async-mutex';
import {
  IndexingError,
  LifecycleStates,
  PolicyDeniedError,
} from '@deltadao/nautilus';
import { Network, PRICING_CONFIGS, resolveNetworkConfig } from './config.js';

// the default network, without environment overrides
const NETWORK_CONFIG = resolveNetworkConfig(Network.OPSEPOLIA, () => undefined);
import {
  ComputeToDataResponseState,
  ComputeToDataResultType,
  CreateOfferingRequest,
  PontusxOffering,
  Pricing_PricingType,
  SsiPolicy_MatchRule,
} from '../generated/spp_v3.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    waitForIndexer: true,
    extendedResponses: false,
    mutex: new Mutex(),
    nautilus,
  });
  return service;
}

// Blocks are mined at this time (Unix seconds).
const BLOCK_TIME = 1_800_000_000;

// A service with EXTENDED_RESPONSES=true and a chain that knows every block.
function createExtendedService(nautilus: Record<string, Mock> = {}) {
  const service = createService(nautilus);
  Object.assign(service as any, {
    extendedResponses: true,
    provider: {
      getBlock: vi.fn().mockResolvedValue({ timestamp: BLOCK_TIME }),
    },
  });
  return service;
}

// An ethers transaction receipt as nautilus returns it.
const receipt = (hash: string, blockNumber = 10) => ({
  hash,
  blockNumber,
  gasUsed: 21000n,
  gasPrice: 1000n,
});

function datasetOffering(): PontusxOffering {
  return {
    metadata: {
      type: 'dataset',
      name: 'Dataset',
      description: 'A dataset',
      author: 'PTW',
      license: 'MIT',
      licenseDocuments: [],
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
    additionalInformation: { termsAndConditions: true },
  };
}

// The Gaia-X parts of the reference DDO the C4DPP workshop is based on.
const DSO_CREDENTIAL =
  'https://delta-dao.com/.well-known/40_gx_digitalserviceoffering_noise_levels.jwt';
const LEGAL_PERSON =
  'https://delta-dao.com/.well-known/40_gx_legalperson_deltaDAO.jwt';
const TERMS =
  'https://delta-dao.com/assets/terms_99d96c60d45714df1e333fccc019aa7592e111013db80a30306bca9f50e8caad_deltaDAO.pdf';
const TERMS_SHA256 =
  '39bb3dc7787a812a008225f871f2a7368cb3794412b1b764061c2fc44f905da7';
const GAIAX_SSI_POLICY = {
  type: 'SSIpolicy',
  values: [
    {
      request_credentials: [
        'gx:LegalPerson',
        'gx:Issuer',
        'gx:VatID',
        'gx:LeiCode',
        'gx:EORI',
      ].map((type) => ({ format: 'jwt_vc_json', policies: [], type })),
      vc_policies: ['signature'],
      vp_policies: [
        { policy: 'minimum-credentials', args: '3' },
        {
          policy: 'external-evp-forward',
          args: 'https://www.delta-dao.com/compliance/v2/api/credential-offers/standard-compliance',
        },
        {
          policy: 'vp_required_credentials',
          args: '{"required":[{"credential_type":"gx:LegalPerson"},{"credential_type":"gx:Issuer"},{"any_of":["gx:EORI","gx:LeiCode","gx:VatID"]}]}',
        },
      ],
    },
  ],
};

function gaiaXOffering(): PontusxOffering {
  const offering = datasetOffering();
  Object.assign(offering.metadata, {
    providedBy: LEGAL_PERSON,
    license: '',
    licenseDocuments: [
      { url: TERMS, fileType: 'application/pdf', sha256: TERMS_SHA256 },
    ],
  });
  offering.additionalInformation = {
    termsAndConditions: true,
    gaiaX: { serviceOfferingCredential: DSO_CREDENTIAL },
  };
  offering.ssiPolicy = {
    gaiaX: true,
    requestCredentials: [],
    vcPolicies: [],
    vpPolicies: [],
    matchAllow: SsiPolicy_MatchRule.DEFAULT,
    matchDeny: SsiPolicy_MatchRule.DEFAULT,
  };
  return offering;
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
      });
      expect(asset.ddo.metadata.license).toEqual({ name: 'MIT' });

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
      expect(ddo.language).toEqual({ language: 'de', direction: 'ltr' });
    });

    it('tags the content with a direction given without language', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.metadata.direction = 'rtl';

      await createService({ publish }).publishAsset(offering);

      expect((publish.mock.calls[0][0] as any).ddo.language).toEqual({
        language: 'en',
        direction: 'rtl',
      });
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

    it('publishes the minimal request of examples/', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const service = createService({ publish });
      // decoded with the defaults of unset fields, as @grpc/proto-loader does
      const request = CreateOfferingRequest.fromJSON(
        JSON.parse(
          readFileSync(
            resolve(
              import.meta.dirname,
              '../../examples/create-offering-minimal.json',
            ),
            'utf8',
          ),
        ),
      );

      await service.publishAsset(request.offerings[0].pontusxOffering);

      const { ddo } = publish.mock.calls[0][0] as any;
      expect(ddo.metadata).toMatchObject({
        type: 'dataset',
        name: 'Machine data',
        providedBy: 'https://example.org/.well-known/gx_legalperson.jwt',
      });
      expect(ddo.services[0]).toMatchObject({
        type: 'access',
        timeout: 86400,
        serviceEndpoint: 'https://node.demo.pontus-x.eu',
        pricing: { type: 'free' },
      });
      expect(ddo.credentials.allow).toEqual([
        { type: 'address', values: [{ address: '*' }] },
      ]);
    });

    it('rebuilds the Gaia-X parts of the reference DDO', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const service = createService({ publish });

      await service.publishAsset(gaiaXOffering());

      const { ddo } = publish.mock.calls[0][0] as any;
      expect(ddo.metadata).toMatchObject({
        providedBy: LEGAL_PERSON,
        license: {
          name: TERMS,
          licenseDocuments: [
            {
              name: TERMS,
              fileType: 'application/pdf',
              sha256: TERMS_SHA256,
              mirrors: [{ type: 'url', method: 'get', url: TERMS }],
            },
          ],
        },
        additionalInformation: {
          termsAndConditions: true,
          gaiaX: { serviceOfferingCredential: DSO_CREDENTIAL },
        },
        links: {
          'Digital Service Offering Credential': DSO_CREDENTIAL,
          'Service Contract': TERMS,
        },
      });
      expect(ddo.credentials).toEqual({
        allow: [
          { type: 'address', values: [{ address: '*' }] },
          GAIAX_SSI_POLICY,
        ],
        match_deny: 'any',
      });
      // the policy is set on the asset, not on its services
      expect(ddo.services[0].credentials).toEqual({});
      expect((service as any).logger.warn).not.toHaveBeenCalled();
    });

    it('checks the Gaia-X presentation with the configured compliance service', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const service = createService({ publish });
      (service as any).configService.get.mockImplementation((key: string) =>
        key === 'GAIAX_EVP_URL' ? 'https://gxdch.example.org/vc' : undefined,
      );

      await service.publishAsset(gaiaXOffering());

      const [, ssiPolicy] = (publish.mock.calls[0][0] as any).ddo.credentials
        .allow;
      expect(ssiPolicy.values[0].vp_policies).toContainEqual({
        policy: 'external-evp-forward',
        args: 'https://gxdch.example.org/vc',
      });
    });

    it('publishes without SSI policy and warns about a providedBy that is no URL', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const service = createService({ publish });

      await service.publishAsset(datasetOffering());

      const { ddo } = publish.mock.calls[0][0] as any;
      expect(ddo.credentials).toEqual({
        allow: [{ type: 'address', values: [{ address: '*' }] }],
      });
      expect(ddo.services[0].credentials).toEqual({});
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("providedBy 'PTW'"),
      );
    });

    it('sets an SSI policy of its own on a service', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });
      const offering = datasetOffering();
      offering.services[0].ssiPolicy = {
        gaiaX: false,
        requestCredentials: [
          { type: 'ProofOfResidence', format: 'jwt_vc_json', policies: [] },
        ],
        vcPolicies: ['signature', 'expired'],
        vpPolicies: [{ policy: 'minimum-credentials', args: '1' }],
        matchAllow: SsiPolicy_MatchRule.ANY,
        matchDeny: SsiPolicy_MatchRule.DEFAULT,
      };

      await createService({ publish }).publishAsset(offering);

      const { ddo } = publish.mock.calls[0][0] as any;
      expect(ddo.services[0].credentials).toEqual({
        allow: [
          {
            type: 'SSIpolicy',
            values: [
              {
                request_credentials: [
                  {
                    type: 'ProofOfResidence',
                    format: 'jwt_vc_json',
                    policies: [],
                  },
                ],
                vc_policies: ['signature', 'expired'],
                vp_policies: [{ policy: 'minimum-credentials', args: '1' }],
              },
            ],
          },
          { type: 'address', values: [{ address: '*' }] },
        ],
        match_allow: 'any',
      });
      expect(ddo.credentials.allow).toEqual([
        { type: 'address', values: [{ address: '*' }] },
      ]);
    });

    it.each([
      [
        'VC policies without request credentials',
        (offering: PontusxOffering) => {
          offering.ssiPolicy = {
            gaiaX: false,
            requestCredentials: [],
            vcPolicies: ['signature'],
            vpPolicies: [],
            matchAllow: SsiPolicy_MatchRule.DEFAULT,
            matchDeny: SsiPolicy_MatchRule.DEFAULT,
          };
        },
        'needs request credentials',
      ],
      [
        'a license document hash that is no SHA-256',
        (offering: PontusxOffering) => {
          offering.metadata.licenseDocuments = [{ url: TERMS, sha256: 'abc' }];
        },
        'is not 64 hex characters',
      ],
    ])('refuses %s', async (_case, change, reason) => {
      const publish = vi.fn();
      const offering = datasetOffering();
      change(offering);

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

    it('waits for the indexer', async () => {
      const publish = vi.fn().mockResolvedValue({ ddo: { id: 'did:ope:1' } });

      await createService({ publish }).publishAsset(datasetOffering());

      expect(publish).toHaveBeenCalledWith(expect.anything(), {
        waitForIndexer: true,
      });
    });

    describe('with EXTENDED_RESPONSES', () => {
      const published = () => ({
        nftAddress: '0x00000000000000000000000000000000000000a1',
        ddo: {
          ...assetV5([
            { id: 'access-1', type: 'access', datatokenAddress: '0xDT1' },
            { id: 'compute-1', type: 'compute', datatokenAddress: '0xDT2' },
          ]),
          id: 'did:ope:1',
        },
        services: [
          { datatokenAddress: '0xdt1', tx: receipt('0xt1', 8) },
          { datatokenAddress: '0xdt2', tx: receipt('0xt2', 9) },
        ],
        setMetadataTxReceipt: receipt('0xmeta', 10),
        indexed: true,
      });

      it('returns the transactions and times of the publication', async () => {
        const publish = vi.fn().mockResolvedValue(published());

        const result = await createExtendedService({ publish }).publishAsset(
          datasetOffering(),
        );

        expect(result.receipt).toEqual({
          did: 'did:ope:1',
          nftAddress: '0x00000000000000000000000000000000000000a1',
          datatokens: { 'access-1': '0xDT1', 'compute-1': '0xDT2' },
          transactions: [
            {
              purpose: 'datatoken:access-1',
              txHash: '0xt1',
              blockNumber: 8,
              gasUsed: '21000',
              effectiveGasPrice: '1000',
            },
            expect.objectContaining({
              purpose: 'datatoken:compute-1',
              txHash: '0xt2',
            }),
            expect.objectContaining({
              purpose: 'setMetadata',
              txHash: '0xmeta',
            }),
          ],
          submittedAt: expect.any(String),
          metadataMinedAt: new Date(BLOCK_TIME * 1000).toISOString(),
          indexedAt: expect.any(String),
        });
        expect(result.ddo.id).toBe('did:ope:1');
      });

      it('leaves indexedAt unset without waiting for the indexer', async () => {
        const { indexed: _, ...notIndexed } = published();
        const publish = vi.fn().mockResolvedValue(notIndexed);

        const { receipt } = await createExtendedService({
          publish,
        }).publishAsset(datasetOffering());

        expect(receipt).not.toHaveProperty('indexedAt');
        expect(receipt).toHaveProperty('metadataMinedAt');
      });

      it('returns no receipt when it is off', async () => {
        const publish = vi.fn().mockResolvedValue(published());

        const result = await createService({ publish }).publishAsset(
          datasetOffering(),
        );

        expect(result).not.toHaveProperty('receipt');
      });
    });

    it('names the DID of an asset that is on chain but was not indexed', async () => {
      const published = {
        nftAddress: '0x0000000000000000000000000000000000000002',
        ddo: { id: 'did:ope:1' },
        setMetadataTxReceipt: { hash: '0xabc' },
      };
      const publish = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new IndexingError('did:ope:1', { valid: false, error: 'bad DDO' }),
            { published },
          ),
        );

      const err = await createService({ publish })
        .publishAsset(datasetOffering())
        .catch((e) => e);

      expect(err).toBeInstanceOf(RpcException);
      expect(err.getError()).toMatchObject({
        code: GrpcStatusCode.INTERNAL,
        message:
          'did:ope:1 is on chain (tx 0xabc), but the ocean-node did not index it: bad DDO. Do not publish it again.',
      });
      expect(err.stack).toBeUndefined();
      expect(JSON.parse(err.getError().details)).toEqual({
        did: 'did:ope:1',
        nftAddress: published.nftAddress,
        txHash: '0xabc',
        indexingError: 'bad DDO',
      });
    });

    it('reports a timed out wait for the indexer as DEADLINE_EXCEEDED', async () => {
      const publish = vi.fn().mockRejectedValue(
        Object.assign(
          new Error(
            'not indexed after 300000 ms. The metadata transaction 0xabc was mined, so 0x2 carries the new metadata; the full result is on error.published.',
          ),
          {
            published: {
              nftAddress: '0x2',
              ddo: { id: 'did:ope:1' },
              setMetadataTxReceipt: { hash: '0xabc' },
            },
          },
        ),
      );

      await expect(
        createService({ publish }).publishAsset(datasetOffering()),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.DEADLINE_EXCEEDED,
          message:
            'did:ope:1 is on chain (tx 0xabc), but the ocean-node did not index it: not indexed after 300000 ms. Do not publish it again.',
        },
      });
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

    // The reference DDO as stored: SSI policy, license documents and Gaia-X information.
    async function updateGaiaX(changes: object) {
      const asset = publishedAsset();
      asset.credentialSubject.credentials.allow.unshift(GAIAX_SSI_POLICY);
      Object.assign(asset.credentialSubject.metadata, {
        description: { '@value': 'A dataset', '@language': 'en' },
        author: 'PTW',
        providedBy: LEGAL_PERSON,
        license: {
          name: TERMS,
          licenseDocuments: [{ name: TERMS, sha256: TERMS_SHA256 }],
        },
        additionalInformation: {
          termsAndConditions: true,
          gaiaX: { serviceOfferingCredential: DSO_CREDENTIAL },
        },
      });
      const edit = vi.fn().mockResolvedValue({ txHash: '0xabc' });
      await createService({
        getAsset: vi.fn().mockResolvedValue(asset),
        edit,
      }).updateOffering({
        pontusxUpdateOffering: {
          did: 'did:ope:1234',
          updateServices: [],
          credentials: null,
          ...changes,
        },
      } as any);
      return (edit.mock.calls[0][0] as any).ddo;
    }

    it('keeps the stored SSI policy when none is given', async () => {
      const ddo = await updateGaiaX({});

      expect(ddo.credentials.allow).toContainEqual(GAIAX_SSI_POLICY);
    });

    it('removes the stored SSI policy with one without request credentials', async () => {
      const ddo = await updateGaiaX({
        ssiPolicy: {
          gaiaX: false,
          requestCredentials: [],
          vcPolicies: [],
          vpPolicies: [],
          matchAllow: SsiPolicy_MatchRule.DEFAULT,
          matchDeny: SsiPolicy_MatchRule.DEFAULT,
        },
      });

      expect(ddo.credentials.allow).toEqual([
        { type: 'address', values: [{ address: '*' }] },
      ]);
    });

    it('links a new service offering credential without changing the metadata', async () => {
      const credential = 'https://example.org/.well-known/dso-v2.jwt';
      const ddo = await updateGaiaX({
        additionalInformation: {
          termsAndConditions: true,
          gaiaX: { serviceOfferingCredential: credential },
        },
      });

      expect(ddo.metadata.additionalInformation).toEqual({
        termsAndConditions: true,
        gaiaX: { serviceOfferingCredential: credential },
      });
      expect(ddo.metadata.links).toMatchObject({
        'Digital Service Offering Credential': credential,
      });
      // unset in the builder, so the published license is kept
      expect(ddo.metadata).not.toHaveProperty('license');
    });

    it('keeps the stored license documents when the metadata gives none', async () => {
      const ddo = await updateGaiaX({
        metadata: { ...datasetOffering().metadata, license: '' },
      });

      expect(ddo.metadata.license).toEqual({
        name: TERMS,
        licenseDocuments: [{ name: TERMS, sha256: TERMS_SHA256 }],
      });
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

    it('returns the metadata transaction with EXTENDED_RESPONSES', async () => {
      const asset = publishedAsset();
      const edit = vi.fn().mockResolvedValue({
        nftAddress: asset.credentialSubject.nftAddress,
        ddo: asset,
        services: [],
        setMetadataTxReceipt: receipt('0xmeta'),
        indexed: true,
      });
      const service = createExtendedService({
        getAsset: vi.fn().mockResolvedValue(asset),
        edit,
      });

      const result = await service.updateOffering({
        pontusxUpdateOffering: {
          did: 'did:ope:1234',
          updateServices: [],
          credentials: null,
        },
      } as any);

      expect(result.receipt).toMatchObject({
        did: 'did:ope:1234',
        nftAddress: asset.credentialSubject.nftAddress,
        transactions: [{ purpose: 'setMetadata', txHash: '0xmeta' }],
        metadataMinedAt: new Date(BLOCK_TIME * 1000).toISOString(),
        indexedAt: expect.any(String),
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
    const DATATOKEN = '0x00000000000000000000000000000000000000d1';

    function computeService(nautilus: Record<string, Mock>) {
      const dataset = assetV5([
        { id: 'access-1', type: 'access' },
        {
          id: 'compute-1',
          type: 'compute',
          datatokenAddress: DATATOKEN,
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
      const accessOnly = assetV5([{ id: 'access-2', type: 'access' }]);
      const service = createService({
        getAsset: vi.fn(async (did: string) =>
          did === 'did:ope:algo'
            ? algorithm
            : did === 'did:ope:access-only'
              ? accessOnly
              : dataset,
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
      additionalDatasets: [],
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
      ).resolves.toEqual({ jobId: [JOB_ID], orders: [], providerFees: [] });

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
      expect(compute.mock.calls[0][0]).not.toHaveProperty('additionalDatasets');
      expect((service as any).redis.rpush).toHaveBeenCalledWith(
        expect.any(String),
        JOB_ID,
      );
    });

    it('runs on further datasets, each with its compute service and typed userdata', async () => {
      const compute = vi.fn().mockResolvedValue({ jobs: [{ jobId: JOB_ID }] });

      await computeService({ compute }).requestComputeToData({
        ...request,
        additionalDatasets: [
          { did: 'did:ope:model-1', userdata: { rows: '1' } },
          { did: 'did:ope:model-2', serviceId: 'compute-1', userdata: {} },
          { did: 'did:ope:model-3', userdata: { rows: '3' } },
        ],
      });

      expect(compute.mock.calls[0][0].dataset.did).toBe('did:ope:1234');
      expect(compute.mock.calls[0][0].additionalDatasets).toEqual([
        {
          did: 'did:ope:model-1',
          serviceId: 'compute-1',
          userdata: { rows: 1 },
        },
        { did: 'did:ope:model-2', serviceId: 'compute-1', userdata: undefined },
        {
          did: 'did:ope:model-3',
          serviceId: 'compute-1',
          userdata: { rows: 3 },
        },
      ]);
    });

    describe('with EXTENDED_RESPONSES', () => {
      const ALGO_TX = '0x' + '1'.repeat(64);
      const DATA_TX = '0x' + '2'.repeat(64);

      function extended(nautilus: Record<string, Mock>) {
        const service = computeService(nautilus);
        Object.assign(service as any, {
          extendedResponses: true,
          provider: {
            getBlockNumber: vi.fn().mockResolvedValue(100),
            // the algorithm's order is older than the job, the dataset's new
            getTransactionReceipt: vi.fn(async (hash: string) => ({
              blockNumber: hash === ALGO_TX ? 90 : 101,
            })),
          },
        });
        return service;
      }

      it('returns the orders, payments and timing of a paid job', async () => {
        const compute = vi.fn().mockResolvedValue({
          jobs: [{ jobId: JOB_ID }],
          environment: { id: 'env-1', consumerAddress: '0xpayee' },
          orders: {
            'did:ope:algo#access-a': ALGO_TX,
            'did:ope:1234#compute-1': DATA_TX,
          },
          initializeResults: {
            datasets: [
              {
                datatoken: DATATOKEN.toUpperCase().replace('0X', '0x'),
                providerFee: {
                  providerFeeAddress: '0xnode',
                  providerFeeToken: '0xtoken',
                  providerFeeAmount: '1000',
                  validUntil: '1800000000',
                  v: 27,
                  r: '0xsignature-r',
                  s: '0xsignature-s',
                  providerData: '0xdata',
                },
              },
            ],
            payment: {
              escrowAddress: '0xescrow',
              chainId: 11155420,
              payee: '0xpayee',
              token: '0xtoken',
              amount: 2500000,
              minLockSeconds: 3600,
            },
          },
        });

        const response = await extended({ compute }).requestComputeToData(
          request,
        );

        expect(response).toEqual({
          jobId: [JOB_ID],
          consumerAddress: OWNER,
          computeEnv: 'env-1',
          orders: [
            { input: 'did:ope:algo#access-a', txHash: ALGO_TX, reused: true },
            { input: 'did:ope:1234#compute-1', txHash: DATA_TX, reused: false },
          ],
          escrowPayment: {
            escrowAddress: '0xescrow',
            token: '0xtoken',
            amount: '2500000',
            payee: '0xpayee',
            minLockSeconds: 3600,
          },
          providerFees: [
            {
              input: 'did:ope:1234#compute-1',
              token: '0xtoken',
              amount: '1000',
              payee: '0xnode',
              validUntil: '1800000000',
            },
          ],
          submittedAt: expect.any(String),
          startedAt: expect.any(String),
        });
        expect(Date.parse(response.startedAt!)).toBeGreaterThanOrEqual(
          Date.parse(response.submittedAt!),
        );
        // no signatures or provider data
        expect(JSON.stringify(response)).not.toMatch(/signature|0xdata/);
      });

      it('returns no orders or payments for a free job', async () => {
        const freeCompute = vi.fn().mockResolvedValue({
          jobs: [{ jobId: JOB_ID }],
          environment: { id: 'env-1' },
        });

        const response = await extended({ freeCompute }).requestComputeToData({
          ...request,
          free: true,
        });

        expect(response).toMatchObject({
          jobId: [JOB_ID],
          computeEnv: 'env-1',
          orders: [],
          providerFees: [],
        });
        expect(response).not.toHaveProperty('escrowPayment');
      });

      it('leaves reused unset when the chain cannot be read', async () => {
        const compute = vi.fn().mockResolvedValue({
          jobs: [{ jobId: JOB_ID }],
          orders: { 'did:ope:1234#compute-1': DATA_TX },
        });
        const service = extended({ compute });
        (service as any).provider.getBlockNumber.mockRejectedValue(
          new Error('rpc down'),
        );

        const response = await service.requestComputeToData(request);

        expect(response.orders).toEqual([
          { input: 'did:ope:1234#compute-1', txHash: DATA_TX },
        ]);
      });
    });

    it('passes further datasets to a free job too', async () => {
      const freeCompute = vi
        .fn()
        .mockResolvedValue({ jobs: [{ jobId: JOB_ID }] });

      await computeService({ freeCompute }).requestComputeToData({
        ...request,
        free: true,
        additionalDatasets: [{ did: 'did:ope:model-1', userdata: {} }],
      });

      expect(freeCompute.mock.calls[0][0].additionalDatasets).toEqual([
        { did: 'did:ope:model-1', serviceId: 'compute-1', userdata: undefined },
      ]);
    });

    it('names the index and DID of a further dataset without compute service', async () => {
      const compute = vi.fn();

      await expect(
        computeService({ compute }).requestComputeToData({
          ...request,
          additionalDatasets: [
            { did: 'did:ope:model-1', userdata: {} },
            { did: 'did:ope:access-only', userdata: {} },
          ],
        }),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message:
            'additionalDatasets[1] (did:ope:access-only) has no compute service',
        },
      });
      expect(compute).not.toHaveBeenCalled();
    });

    it('refuses a dataset service given twice', async () => {
      const compute = vi.fn();

      await expect(
        computeService({ compute }).requestComputeToData({
          ...request,
          additionalDatasets: [
            { did: 'did:ope:1234', serviceId: 'compute-1', userdata: {} },
          ],
        }),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.INVALID_ARGUMENT,
          message:
            'additionalDatasets[0] (did:ope:1234): service compute-1 is already an input of the job',
        },
      });
      expect(compute).not.toHaveBeenCalled();
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

    it('returns the setMetadataState transaction with EXTENDED_RESPONSES', async () => {
      const setAssetLifecycleState = vi
        .fn()
        .mockResolvedValueOnce(receipt('0xstate'))
        .mockResolvedValueOnce(undefined);
      const service = createExtendedService({
        getAsset: vi.fn().mockResolvedValue(assetV5([])),
        setAssetLifecycleState,
      });

      const changed = await service.setState(
        'did:ope:1234',
        LifecycleStates.ASSET_UNLISTED,
      );
      const unchanged = await service.setState(
        'did:ope:1234',
        LifecycleStates.ASSET_UNLISTED,
      );

      expect(changed.receipt).toEqual({
        did: 'did:ope:1234',
        nftAddress: '0x0000000000000000000000000000000000000002',
        datatokens: {},
        transactions: [
          {
            purpose: 'setMetadataState',
            txHash: '0xstate',
            blockNumber: 10,
            gasUsed: '21000',
            effectiveGasPrice: '1000',
          },
        ],
        submittedAt: expect.any(String),
        metadataMinedAt: new Date(BLOCK_TIME * 1000).toISOString(),
      });
      expect(unchanged.receipt).toMatchObject({ transactions: [] });
      expect(unchanged.receipt).not.toHaveProperty('metadataMinedAt');
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

  describe('getComputeEnvironments', () => {
    const EURAU = '0xD35141583f374d401fee1BFdDc35910E1D33a588';

    it('lists the environments with their resources and prices on the chain', async () => {
      const getComputeEnvironments = vi.fn().mockResolvedValue([
        {
          id: '0xenv-paid',
          description: 'Paid environment',
          consumerAddress: '0xpayee',
          maxJobDuration: 3600,
          maxJobs: 4,
          runningJobs: 1,
          queuedJobs: 2,
          queMaxWaitTime: 600,
          platform: { os: 'linux', architecture: 'x86_64' },
          resources: [
            { id: 'cpu', type: 'cpu', min: 1, max: 8, total: 8, inUse: 2 },
            { id: 'ram', type: 'ram', min: 1, max: 16, init: { secret: 'x' } },
          ],
          fees: {
            '11155420': [
              {
                feeToken: EURAU,
                prices: [
                  { id: 'cpu', price: 0.01 },
                  { id: 'ram', price: 0.005 },
                ],
              },
            ],
            '32457': [
              { feeToken: '0xother', prices: [{ id: 'cpu', price: 1 }] },
            ],
          },
        },
        {
          id: '0xenv-free',
          consumerAddress: '0xpayee',
          runningJobs: 0,
          fees: {},
          free: {
            maxJobDuration: 60,
            maxJobs: 1,
            access: { addresses: ['0xallowed'], accessLists: [] },
            resources: [{ id: 'cpu', max: 1 }],
          },
        },
      ]);

      const environments = await createService({
        getComputeEnvironments,
      }).getComputeEnvironments();

      expect(environments).toEqual([
        {
          id: '0xenv-paid',
          description: 'Paid environment',
          consumerAddress: '0xpayee',
          maxJobDuration: 3600,
          maxJobs: 4,
          runningJobs: 1,
          queuedJobs: 2,
          queueMaxWaitTime: 600,
          platform: 'linux/x86_64',
          resources: [
            { id: 'cpu', type: 'cpu', min: 1, max: 8, total: 8, inUse: 2 },
            { id: 'ram', type: 'ram', min: 1, max: 16 },
          ],
          // only the gateway's chain
          fees: [
            {
              token: EURAU,
              prices: [
                { id: 'cpu', price: 0.01 },
                { id: 'ram', price: 0.005 },
              ],
            },
          ],
        },
        {
          id: '0xenv-free',
          consumerAddress: '0xpayee',
          runningJobs: 0,
          resources: [],
          fees: [],
          free: {
            maxJobDuration: 60,
            maxJobs: 1,
            allowedAddresses: ['0xallowed'],
            resources: [{ id: 'cpu', max: 1 }],
          },
        },
      ]);
    });

    it('reports an unreachable node as UNAVAILABLE', async () => {
      await expect(
        createService({
          getComputeEnvironments: vi
            .fn()
            .mockRejectedValue(new Error('connect ECONNREFUSED')),
        }).getComputeEnvironments(),
      ).rejects.toMatchObject({
        error: { code: GrpcStatusCode.UNAVAILABLE },
      });
    });
  });

  describe('getComputeToDataStatusDetails', () => {
    // a finished paid job, as ocean-node reports it
    const job = {
      owner: OWNER,
      jobId: JOB('1'),
      status: 70,
      statusText: 'Job finished',
      dateCreated: '1793000000.123',
      dateFinished: '1793000100.456',
      algoStartTimestamp: '1793000030.000',
      algoStopTimestamp: '1793000090.000',
      algoDuration: 60,
      environment: 'env-1',
      resources: [
        { id: 'cpu', amount: 2 },
        { id: 'ram', amount: 4 },
      ],
      isFree: false,
      maxJobDuration: 600,
      queueMaxWaitTime: 0,
      expireTimestamp: 1793086500,
      payment: {
        chainId: 11155420,
        token: '0xtoken',
        lockTx: '0xlock',
        claimTx: '0xclaim',
        cancelTx: null,
        cost: 0.5,
      },
      results: [
        {
          filename: 'algorithm.log',
          filesize: 120,
          type: 'algorithmLog',
          index: 0,
        },
        { filename: 'outputs.tar', filesize: 4096, type: 'output', index: 1 },
      ],
      terminationDetails: { exitCode: 0, OOMKilled: false },
      runtimeMetrics: { cpu: { usagePercent: 80 } },
      inputDID: ['did:ope:1', 'did:ope:2'],
      algoDID: 'did:ope:algo',
    };

    it('maps the job the node reports', async () => {
      const service = createExtendedService({
        getComputeStatus: vi.fn().mockResolvedValue(job),
      });

      await expect(
        service.getComputeToDataStatusDetails(JOB('1')),
      ).resolves.toEqual({
        status: 70,
        dateCreated: '1793000000.123',
        dateFinished: '1793000100.456',
        algoStartTimestamp: '1793000030.000',
        algoStopTimestamp: '1793000090.000',
        algoDuration: 60,
        computeEnv: 'env-1',
        resources: [
          { id: 'cpu', amount: 2 },
          { id: 'ram', amount: 4 },
        ],
        isFree: false,
        payment: {
          token: '0xtoken',
          cost: '0.5',
          lockTx: '0xlock',
          claimTx: '0xclaim',
        },
        results: [
          {
            filename: 'algorithm.log',
            type: 'algorithmLog',
            filesize: 120,
            index: 0,
          },
          { filename: 'outputs.tar', type: 'output', filesize: 4096, index: 1 },
        ],
        exitCode: 0,
        oomKilled: false,
        inputDids: ['did:ope:1', 'did:ope:2'],
        algorithmDid: 'did:ope:algo',
        runtimeMetrics: '{"cpu":{"usagePercent":80}}',
        maxJobDuration: 600,
        queueMaxWaitTime: 0,
        expireTimestamp: '1793086500',
      });
    });

    it('leaves the payment of a free job unset', async () => {
      const { payment: _, ...free } = job;
      const service = createExtendedService({
        getComputeStatus: vi
          .fn()
          .mockResolvedValue({ ...free, isFree: true, dateFinished: null }),
      });

      const details = await service.getComputeToDataStatusDetails(JOB('1'));

      expect(details).not.toHaveProperty('payment');
      expect(details).not.toHaveProperty('dateFinished');
      expect(details.isFree).toBe(true);
    });

    it('refuses details without EXTENDED_RESPONSES', async () => {
      const getComputeStatus = vi.fn();

      await expect(
        createService({ getComputeStatus }).getComputeToDataStatusDetails(
          JOB('1'),
        ),
      ).rejects.toMatchObject({
        error: {
          code: GrpcStatusCode.FAILED_PRECONDITION,
          message: expect.stringContaining('EXTENDED_RESPONSES'),
        },
      });
      expect(getComputeStatus).not.toHaveBeenCalled();
    });
  });

  describe('getComputeToDataResult', () => {
    it.each([
      [0, { jobId: JOB('3'), resultIndex: 0 }],
      [2, { jobId: JOB('3'), resultIndex: 2 }],
      [undefined, { jobId: JOB('3') }],
    ])(
      'returns the URL of result %p, by default the output',
      async (jobIndex, expected) => {
        const getComputeResult = vi.fn().mockResolvedValue('https://result');

        await expect(
          createService({ getComputeResult }).getComputeToDataResult(
            JOB('3'),
            ComputeToDataResultType.C2D_URI,
            jobIndex,
          ),
        ).resolves.toEqual({
          state: ComputeToDataResponseState.FINISHED,
          data: 'https://result',
        });
        expect(getComputeResult).toHaveBeenCalledWith(expected);
      },
    );

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
