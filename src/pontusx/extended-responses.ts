// The transaction, payment and timing details responses carry with EXTENDED_RESPONSES=true,
// mapped from what nautilus and the ocean-node return. Only addresses, amounts and hashes
// are passed on: no fee signatures, provider data or node URLs.
import type { ComputeResult } from '@deltadao/nautilus';
import type { EscrowPayment, ProviderFee } from '../generated/spp_v3.js';

type InitializeResults = Partial<ComputeResult['initializeResults']>;

/** A compute job input as nautilus keys its orders: `<did>#<serviceId>`. */
export function toInput(did: string, serviceId: string): string {
  return `${did}#${serviceId}`;
}

/** An amount in a token's smallest unit as a decimal string, never in exponent notation. */
export function toAmount(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value).toString();
  }
  return String(value);
}

/** The escrow payment the node quoted, or `undefined` for a job without one. */
export function toEscrowPayment(
  initializeResults: InitializeResults | undefined,
): EscrowPayment | undefined {
  const payment = initializeResults?.payment;
  if (!payment) return undefined;
  return {
    escrowAddress: payment.escrowAddress,
    token: payment.token,
    amount: toAmount(payment.amount),
    payee: payment.payee,
    ...(payment.minLockSeconds !== undefined
      ? { minLockSeconds: Number(payment.minLockSeconds) }
      : {}),
  };
}

/**
 * The provider fees the node quoted. Dataset fees are matched to their input by datatoken,
 * as nautilus matches them; `datasets` are the job's dataset inputs with their datatokens.
 */
export function toProviderFees(
  initializeResults: InitializeResults | undefined,
  datasets: { input: string; datatoken?: string }[],
  algorithm: string,
): ProviderFee[] {
  const fees: ProviderFee[] = [];
  for (const result of initializeResults?.datasets ?? []) {
    if (!result.providerFee) continue;
    const dataset = datasets.find(
      ({ datatoken }) =>
        datatoken &&
        datatoken.toLowerCase() === result.datatoken?.toLowerCase(),
    );
    fees.push(
      toProviderFee(
        dataset?.input ?? result.datatoken ?? 'unknown',
        result.providerFee,
      ),
    );
  }
  const algorithmFee = initializeResults?.algorithm?.providerFee;
  if (algorithmFee) fees.push(toProviderFee(algorithm, algorithmFee));
  return fees;
}

function toProviderFee(
  input: string,
  fee: NonNullable<NonNullable<InitializeResults['algorithm']>['providerFee']>,
): ProviderFee {
  return {
    input,
    token: fee.providerFeeToken,
    amount: toAmount(fee.providerFeeAmount),
    ...(fee.providerFeeAddress ? { payee: fee.providerFeeAddress } : {}),
    ...(fee.validUntil !== undefined && fee.validUntil !== null
      ? { validUntil: String(fee.validUntil) }
      : {}),
  };
}
