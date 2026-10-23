import { describe, it, expect } from 'vitest';
import { getOceanConfig } from '@deltadao/nautilus';
import {
  Network,
  PRICING_CONFIGS,
  resolveNetworkConfig,
  selectNetwork,
} from './config.js';

const env =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe('selectNetwork', () => {
  it('defaults to OP Sepolia', () => {
    expect(selectNetwork(undefined)).toBe(Network.OPSEPOLIA);
    expect(selectNetwork(' ')).toBe(Network.OPSEPOLIA);
  });

  it('accepts a network in any case', () => {
    expect(selectNetwork('pontusxdev')).toBe(Network.PONTUSXDEV);
  });

  it('refuses an unknown network', () => {
    expect(() => selectNetwork('GENX')).toThrow(
      "Unsupported NETWORK 'GENX'. Supported: OPSEPOLIA, PONTUSXTEST, PONTUSXDEV.",
    );
  });
});

describe('resolveNetworkConfig', () => {
  it('uses the demo ocean-node and the contracts ocean.js ships for OP Sepolia', () => {
    const config = resolveNetworkConfig(Network.OPSEPOLIA, env({}));
    const shipped = getOceanConfig(11155420);

    expect(config).toMatchObject({
      chainId: 11155420,
      network: 'optimism_sepolia',
      nodeUri: 'https://sepolia.optimism.io',
      oceanNodeUri: 'https://node.demo.pontus-x.eu',
      nftFactoryAddress: shipped.nftFactoryAddress,
      fixedRateExchangeAddress: shipped.fixedRateExchangeAddress,
      dispenserAddress: shipped.dispenserAddress,
    });
    // a configured escrow pins paid compute to it; ocean.js' is not the node's
    expect(config).not.toHaveProperty('escrow');
  });

  it('pins the escrow only when ESCROW_ADDRESS is set', () => {
    const escrow = '0xfa48673a7C36A2A768f89AC1ee8C355D5c367B02';

    expect(
      resolveNetworkConfig(Network.OPSEPOLIA, env({ ESCROW_ADDRESS: escrow }))
        .escrow,
    ).toBe(escrow);
  });

  it('applies the environment overrides', () => {
    const config = resolveNetworkConfig(
      Network.OPSEPOLIA,
      env({
        OCEAN_NODE_URI: 'https://node.example.org',
        RPC_URL: 'https://rpc.example.org',
      }),
    );

    expect(config).toMatchObject({
      oceanNodeUri: 'https://node.example.org',
      nodeUri: 'https://rpc.example.org',
    });
  });

  it.each([Network.PONTUSXDEV, Network.PONTUSXTEST])(
    'needs OCEAN_NODE_URI for %s',
    (network) => {
      expect(() => resolveNetworkConfig(network, env({}))).toThrow(
        `NETWORK=${network} needs OCEAN_NODE_URI`,
      );
      expect(
        resolveNetworkConfig(
          network,
          env({ OCEAN_NODE_URI: 'https://node.example.org' }),
        ).oceanNodeUri,
      ).toBe('https://node.example.org');
    },
  );
});

describe('PRICING_CONFIGS', () => {
  it('prices OP Sepolia in devEURAU, which has 6 decimals', () => {
    expect(PRICING_CONFIGS.OPSEPOLIA.FIXED_EURAU).toMatchObject({
      type: 'fixed',
      freCreationParams: {
        fixedRateAddress: getOceanConfig(11155420).fixedRateExchangeAddress,
        baseTokenAddress: '0xD35141583f374d401fee1BFdDc35910E1D33a588',
        baseTokenDecimals: 6,
      },
    });
  });

  it('names an exchange for every fixed price', () => {
    for (const pricings of Object.values(PRICING_CONFIGS)) {
      for (const pricing of Object.values(pricings)) {
        if (pricing.type !== 'fixed') continue;
        expect(pricing.freCreationParams.fixedRateAddress).toMatch(
          /^0x[0-9a-fA-F]{40}$/,
        );
      }
    }
  });
});
