// The transaction, payment and timing details responses carry with EXTENDED_RESPONSES=true,
// mapped from what nautilus and the ocean-node return. Only addresses, amounts and hashes
// are passed on: no fee signatures, provider data or node URLs.
import {
  type AssetV5,
  type ComputeResult,
  getServices,
  type NodeComputeJob,
  type PublishResponse,
} from '@deltadao/nautilus';
import type {
  ComputeToDataStatusResponse,
  EscrowPayment,
  ProviderFee,
  PublishReceipt,
  TxReceipt,
} from '../generated/spp_v3.js';

/** The fields of an ethers transaction receipt that are reported. */
export type ReceiptLike = {
  hash: string;
  blockNumber?: number | null;
  gasUsed?: bigint | number | string | null;
  // ethers names the effective gas price of a receipt `gasPrice`
  gasPrice?: bigint | number | string | null;
};

/** A transaction of the gateway, with what it did. */
export function toTxReceipt(purpose: string, receipt: ReceiptLike): TxReceipt {
  return {
    purpose,
    txHash: receipt.hash,
    ...(receipt.blockNumber != null && { blockNumber: receipt.blockNumber }),
    ...(receipt.gasUsed != null && { gasUsed: toAmount(receipt.gasUsed) }),
    ...(receipt.gasPrice != null && {
      effectiveGasPrice: toAmount(receipt.gasPrice),
    }),
  };
}

/** Datatoken address per service id of a DDO v5; none for a DDO nautilus cannot read. */
export function toDatatokens(ddo: unknown): Record<string, string> {
  let services: ReturnType<typeof getServices>;
  try {
    services = getServices(ddo as AssetV5);
  } catch {
    return {};
  }
  return Object.fromEntries(
    services
      .filter((service) => service.datatokenAddress)
      .map((service) => [service.id, service.datatokenAddress]),
  );
}

/**
 * What a publish or edit sent: the datatoken transactions, the metadata transaction and
 * then `more` (e.g. price changes), with the times given.
 */
export function toPublishReceipt(
  published: PublishResponse,
  times: Pick<PublishReceipt, 'submittedAt' | 'metadataMinedAt' | 'indexedAt'>,
  more: TxReceipt[] = [],
): PublishReceipt {
  const datatokens = toDatatokens(published.ddo);
  const serviceOf = (datatoken: string) =>
    Object.keys(datatokens).find(
      (id) => datatokens[id].toLowerCase() === datatoken?.toLowerCase(),
    );
  const transactions = (published.services ?? [])
    .filter(({ tx }) => tx)
    .map(({ tx, datatokenAddress, service }) =>
      toTxReceipt(
        `datatoken:${serviceOf(datatokenAddress) ?? service?.id ?? datatokenAddress}`,
        tx,
      ),
    );
  if (published.setMetadataTxReceipt) {
    transactions.push(
      toTxReceipt('setMetadata', published.setMetadataTxReceipt),
    );
  }
  return {
    did: String(published.ddo?.id),
    nftAddress: published.nftAddress,
    datatokens,
    transactions: [...transactions, ...more],
    ...withoutUndefined(times),
  };
}

/** The details of a compute job the status response carries, as the node reports them. */
export function toComputeJobDetails(
  job: NodeComputeJob,
): Omit<ComputeToDataStatusResponse, 'status' | 'description'> {
  const text = (value: unknown) =>
    value === undefined || value === null || value === ''
      ? undefined
      : String(value);
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const payment = job.payment
    ? withoutUndefined({
        token: text(job.payment.token),
        cost: text(job.payment.cost),
        lockTx: text(job.payment.lockTx),
        claimTx: text(job.payment.claimTx),
        cancelTx: text(job.payment.cancelTx),
      })
    : undefined;
  return {
    ...withoutUndefined({
      dateCreated: text(job.dateCreated),
      dateFinished: text(job.dateFinished),
      algoStartTimestamp: text(job.algoStartTimestamp),
      algoStopTimestamp: text(job.algoStopTimestamp),
      algoDuration: number(job.algoDuration),
      computeEnv: text(job.environment),
      isFree: job.isFree ?? undefined,
      payment,
      exitCode: number(job.terminationDetails?.exitCode),
      oomKilled: job.terminationDetails?.OOMKilled ?? undefined,
      algorithmDid: text(job.algoDID),
      runtimeMetrics: job.runtimeMetrics
        ? JSON.stringify(job.runtimeMetrics)
        : undefined,
      maxJobDuration: number(job.maxJobDuration),
      queueMaxWaitTime: number(job.queueMaxWaitTime),
      expireTimestamp: text(job.expireTimestamp),
    }),
    resources: (job.resources ?? []).map(({ id, amount }) => ({ id, amount })),
    results: (job.results ?? []).map((result, position) => ({
      filename: result.filename,
      type: result.type,
      ...(number(result.filesize) !== undefined && {
        filesize: result.filesize,
      }),
      index: result.index ?? position,
    })),
    inputDids: job.inputDID ?? [],
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

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
