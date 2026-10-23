import {
  type Config,
  getOceanConfig,
  IpfsRemoteStore,
  type PricingConfigWithoutOwner,
  type RemoteStore,
  S3RemoteStore,
  type TokenAmount,
} from '@deltadao/nautilus';
import { isAddress } from 'ethers';

export enum Network {
  OPSEPOLIA = 'OPSEPOLIA',
  PONTUSXTEST = 'PONTUSXTEST',
  PONTUSXDEV = 'PONTUSXDEV',
}

/** The network used when NETWORK is not set. */
export const DEFAULT_NETWORK = Network.OPSEPOLIA;

// Nautilus v2 talks to a single ocean-node (metadata, provider and indexer in one), so the
// Aquarius, Provider and subgraph URLs of v1 are gone. `nodeUri` is still the chain RPC.
export type NetworkConfig = Partial<Config> & {
  chainId: number;
  network: string;
  nodeUri: string;
  oceanNodeUri: string;
};

const OP_SEPOLIA_CHAIN_ID = 11155420;
// The contract addresses ocean.js ships for OP Sepolia. Only these are taken over: nautilus
// merges the rest by chain id, and would treat a configured `escrow` as the caller's pin.
// ocean.js' `escrow` is the chain's plain Escrow, while the node pays out of its
// EnterpriseEscrow, which nautilus finds by itself when none is pinned.
const OP_SEPOLIA = getOceanConfig(OP_SEPOLIA_CHAIN_ID);
const OP_SEPOLIA_CONTRACTS = {
  nftFactoryAddress: OP_SEPOLIA?.nftFactoryAddress,
  fixedRateExchangeAddress: OP_SEPOLIA?.fixedRateExchangeAddress,
  dispenserAddress: OP_SEPOLIA?.dispenserAddress,
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// devEURAU, the payment token of OP Sepolia and of the demo node's compute fees
const OP_SEPOLIA_EURAU = '0xD35141583f374d401fee1BFdDc35910E1D33a588';

// An ocean-node (OceanProtocolEnterprise 4.2.x) serves OP Sepolia at node.demo.pontus-x.eu.
// The Pontus-X chains have none yet (their public endpoints still run the legacy Provider,
// which nautilus v2 cannot use), so OCEAN_NODE_URI is required for them.
export const NETWORK_CONFIGS: {
  [key in Network]: Omit<NetworkConfig, 'oceanNodeUri'> & {
    oceanNodeUri?: string;
  };
} = {
  [Network.OPSEPOLIA]: {
    ...OP_SEPOLIA_CONTRACTS,
    chainId: OP_SEPOLIA_CHAIN_ID,
    network: 'optimism_sepolia',
    nodeUri: 'https://sepolia.optimism.io',
    oceanNodeUri: 'https://node.demo.pontus-x.eu',
    explorerUri: 'https://sepolia-optimism.etherscan.io/',
  },
  [Network.PONTUSXTEST]: {
    chainId: 32457,
    network: 'pontusxtest',
    nodeUri: 'https://rpc.test.pontus-x.eu',
    explorerUri: 'https://explorer.pontus-x.eu/testnet/pontusx',
    oceanTokenAddress: '0x5B190F9E2E721f8c811E4d584383E3d57b865C69',
    oceanTokenSymbol: 'OCEAN',
    fixedRateExchangeAddress: '0xcE0F39abB6DA2aE4d072DA78FA0A711cBB62764E',
    dispenserAddress: '0xaB5B68F88Bc881CAA427007559E9bbF8818026dE',
    startBlock: 82191,
    transactionBlockTimeout: 50,
    transactionConfirmationBlocks: 1,
    transactionPollingTimeout: 750,
    gasFeeMultiplier: 1.1,
    nftFactoryAddress: '0x2C4d542ff791890D9290Eec89C9348A4891A6Fd2',
    opfCommunityFeeCollector: '0xACC8d1B2a0007951fb4ed622ACB1C4fcCAbe778D',
  },
  [Network.PONTUSXDEV]: {
    chainId: 32456,
    network: 'pontusxdev',
    nodeUri: 'https://rpc.dev.pontus-x.eu',
    oceanTokenAddress: '0xdF171F74a8d3f4e2A789A566Dce9Fa4945196112',
    oceanTokenSymbol: 'OCEAN',
    fixedRateExchangeAddress: '0x8372715D834d286c9aECE1AcD51Da5755B32D505',
    dispenserAddress: '0x5461b629E01f72E0A468931A36e039Eea394f9eA',
    nftFactoryAddress: '0xFdC4a5DEaCDfc6D82F66e894539461a269900E13',
  },
};

// The pricing types per network, with the contract addresses of their payment tokens and
// the token decimals as the chain reports them. `fixedRate` is the default price.
export const PRICING_CONFIGS: PricingConfig = {
  [Network.OPSEPOLIA]: {
    FREE: {
      type: 'free',
    },
    FIXED_EURAU: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: OP_SEPOLIA?.fixedRateExchangeAddress,
        baseTokenAddress: OP_SEPOLIA_EURAU,
        baseTokenDecimals: 6,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
  },
  [Network.PONTUSXTEST]: {
    FREE: {
      type: 'free',
    },
    FIXED_OCEAN: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0xcE0F39abB6DA2aE4d072DA78FA0A711cBB62764E',
        baseTokenAddress: '0x5B190F9E2E721f8c811E4d584383E3d57b865C69',
        baseTokenDecimals: 18,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
    FIXED_EUROE: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0xcE0F39abB6DA2aE4d072DA78FA0A711cBB62764E',
        baseTokenAddress: '0xdd0a0278f6BAF167999ccd8Aa6C11A9e2fA37F0a',
        baseTokenDecimals: 6,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
    FIXED_EURAU: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0xcE0F39abB6DA2aE4d072DA78FA0A711cBB62764E',
        baseTokenAddress: '0xE158265FD2be5BCc208621f2c0f8AfCF11aC8408',
        baseTokenDecimals: 6,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
  },
  [Network.PONTUSXDEV]: {
    FREE: {
      type: 'free',
    },
    FIXED_OCEAN: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0x8372715D834d286c9aECE1AcD51Da5755B32D505',
        baseTokenAddress: '0xdF171F74a8d3f4e2A789A566Dce9Fa4945196112',
        baseTokenDecimals: 18,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
    FIXED_EUROE: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0x8372715D834d286c9aECE1AcD51Da5755B32D505',
        baseTokenAddress: '0x8A4826071983655805bF4f29828577Cd6b1aC0cB',
        // unlike EUROe on the testnet, this one has 18 decimals
        baseTokenDecimals: 18,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
    FIXED_EURAU: {
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: '0x8372715D834d286c9aECE1AcD51Da5755B32D505',
        baseTokenAddress: '0x852381bB887d3Cf4AEB9e1E9De3eB033AF82fBeE',
        baseTokenDecimals: 6,
        datatokenDecimals: 18,
        fixedRate: '1',
        marketFee: '0',
        marketFeeCollector: ZERO_ADDRESS,
      },
    },
  },
};

export type PricingConfig = {
  [key in Network]: {
    [key: string]: PricingConfigWithoutOwner;
  };
};

export type EnvReader = (name: string) => string | undefined;

/** The network NETWORK selects, OPSEPOLIA when it is not set. */
export function selectNetwork(value: string | undefined): Network {
  const selected = value?.trim().toUpperCase() || DEFAULT_NETWORK;
  if (!(selected in Network)) {
    throw new Error(
      `Unsupported NETWORK '${value}'. Supported: ${Object.values(Network).join(', ')}.`,
    );
  }
  return Network[selected as keyof typeof Network];
}

/**
 * The network config with the environment overrides applied: OCEAN_NODE_URI, RPC_URL and
 * ESCROW_ADDRESS (the chain's EnterpriseEscrow contract, needed for paid compute on chains
 * whose ocean.js address data lists no escrow, Pontus-X among them).
 */
export function resolveNetworkConfig(
  network: Network,
  env: EnvReader,
): NetworkConfig {
  const { oceanNodeUri: defaultNode, ...defaults } = NETWORK_CONFIGS[network];
  const oceanNodeUri = env('OCEAN_NODE_URI')?.trim() || defaultNode;
  if (!oceanNodeUri) {
    throw new Error(
      `NETWORK=${network} needs OCEAN_NODE_URI: no public ocean-node serves this chain yet.`,
    );
  }
  const config: NetworkConfig = { ...defaults, oceanNodeUri };

  const rpcUrl = env('RPC_URL')?.trim();
  if (rpcUrl) config.nodeUri = rpcUrl;

  const escrow = env('ESCROW_ADDRESS')?.trim();
  if (escrow) {
    if (!isAddress(escrow)) {
      throw new Error(`ESCROW_ADDRESS must be an address, not '${escrow}'.`);
    }
    config.escrow = escrow;
  }

  return config;
}

/**
 * A `<token address>:<amount in the token's smallest unit>` list, comma separated, as used by
 * MAX_PROVIDER_FEE and MAX_ESCROW_PAYMENT. `undefined` when the variable is unset.
 */
export function parseTokenAmounts(
  name: string,
  value: string | undefined,
): TokenAmount[] | undefined {
  if (!value?.trim()) return undefined;

  return value.split(',').map((entry) => {
    const [token, amount, ...rest] = entry.trim().split(':');
    if (rest.length || !token || !isAddress(token) || !/^\d+$/.test(amount)) {
      throw new Error(
        `${name} must be "<token address>:<amount in the token's smallest unit>" pairs, comma separated, not '${entry.trim()}'.`,
      );
    }
    return { token, amount: BigInt(amount) };
  });
}

/** `true` / `false` from the environment, or `undefined` when unset. */
function parseFlag(name: string, value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false, not '${value}'.`);
}

/**
 * Where publish and edit store the node-encrypted DDO envelope, selected by DDO_STORE
 * (`ipfs` or `s3`). `undefined` when no store is configured: reading and consuming work
 * without one, publishing and editing do not.
 */
export function createRemoteStore(env: EnvReader): RemoteStore | undefined {
  const read = (name: string) => env(name)?.trim() || undefined;
  const store =
    read('DDO_STORE')?.toLowerCase() ??
    (read('IPFS_UPLOAD_URL') ? 'ipfs' : undefined);

  if (store === undefined) return undefined;

  if (store === 'ipfs') {
    const uploadUrl = read('IPFS_UPLOAD_URL');
    if (!uploadUrl) throw new Error('DDO_STORE=ipfs needs IPFS_UPLOAD_URL.');

    const jwt = read('IPFS_JWT');
    const gatewayUrl = read('IPFS_GATEWAY_URL');
    const verify = parseFlag('IPFS_VERIFY', env('IPFS_VERIFY'));
    return new IpfsRemoteStore({
      uploadUrl,
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
      probe: 'upload',
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(verify === false ? { verify: false } : {}),
    });
  }

  if (store === 's3') {
    const required = [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_WRITE_ACCESS_KEY_ID',
      'S3_WRITE_SECRET_ACCESS_KEY',
      'S3_READ_ACCESS_KEY_ID',
      'S3_READ_SECRET_ACCESS_KEY',
    ];
    const missing = required.filter((name) => !read(name));
    if (missing.length) {
      throw new Error(`DDO_STORE=s3 needs ${missing.join(', ')}.`);
    }

    return new S3RemoteStore({
      endpoint: read('S3_ENDPOINT'),
      nodeEndpoint: read('S3_NODE_ENDPOINT'),
      region: read('S3_REGION'),
      bucket: read('S3_BUCKET'),
      prefix: read('S3_PREFIX'),
      forcePathStyle: parseFlag(
        'S3_FORCE_PATH_STYLE',
        env('S3_FORCE_PATH_STYLE'),
      ),
      writeCredentials: {
        accessKeyId: read('S3_WRITE_ACCESS_KEY_ID'),
        secretAccessKey: read('S3_WRITE_SECRET_ACCESS_KEY'),
      },
      readCredentials: {
        accessKeyId: read('S3_READ_ACCESS_KEY_ID'),
        secretAccessKey: read('S3_READ_SECRET_ACCESS_KEY'),
      },
    });
  }

  throw new Error(`Unknown DDO_STORE '${store}'. Use 'ipfs' or 's3'.`);
}
