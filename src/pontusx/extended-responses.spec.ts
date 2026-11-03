import { describe, it, expect } from 'vitest';
import {
  toAmount,
  toEscrowPayment,
  toProviderFees,
} from './extended-responses.js';

describe('toAmount', () => {
  it('writes integers without exponent notation', () => {
    expect(toAmount(1e21)).toBe('1000000000000000000000');
    expect(toAmount(10n ** 24n)).toBe('1000000000000000000000000');
    expect(toAmount('2500000')).toBe('2500000');
  });
});

describe('toEscrowPayment', () => {
  it('is unset without a payment', () => {
    expect(toEscrowPayment(undefined)).toBeUndefined();
    expect(toEscrowPayment({ datasets: [] })).toBeUndefined();
  });
});

describe('toProviderFees', () => {
  it('names a dataset fee it cannot match by its datatoken', () => {
    expect(
      toProviderFees(
        {
          datasets: [
            {
              datatoken: '0xother',
              providerFee: {
                providerFeeToken: '0xtoken',
                providerFeeAmount: '5',
              } as any,
            },
          ],
          algorithm: {
            providerFee: {
              providerFeeToken: '0xtoken',
              providerFeeAmount: '0',
            } as any,
          },
        },
        [{ input: 'did:ope:1#compute', datatoken: '0xdt' }],
        'did:ope:algo#access',
      ),
    ).toEqual([
      { input: '0xother', token: '0xtoken', amount: '5' },
      { input: 'did:ope:algo#access', token: '0xtoken', amount: '0' },
    ]);
  });
});
