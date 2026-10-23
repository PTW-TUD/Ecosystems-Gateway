import {
  type AssetV5,
  type CredentialListTypes,
  type DdoCredentials,
  isAddressCredential,
} from '@deltadao/nautilus';

// Compute-to-Data v2 job statuses, as reported by ocean-node (C2DStatusNumber / C2DStatusText).
// A job has finished once ocean-node sets its `dateFinished`; failed jobs end below 70.
export const CtdStatusMap = {
  0: 'Job started',
  1: 'Job queued',
  2: 'Job expired in queue',
  10: 'Pulling algorithm image',
  11: 'Pulling algorithm image failed',
  12: 'Building algorithm image',
  13: 'Building algorithm image failed',
  14: 'Image has vulnerabilities',
  20: 'Configuring volumes',
  21: 'Volume creation failed',
  22: 'Container creation failed',
  30: 'Provisioning data',
  31: 'Data provisioning failed',
  32: 'Algorithm provisioning failed',
  33: 'Data upload to container failed',
  40: 'Running algorithm',
  41: 'Failed to run algorithm',
  42: 'Error: disk quota exceeded',
  50: 'Filtering results',
  60: 'Publishing results',
  61: 'Failed to get outputs folder from container',
  62: 'Failed to upload results to storage',
  70: 'Job finished',
  71: 'Job settling',
} as const;

export type CtdStatusCode = keyof typeof CtdStatusMap;

export const CTD_JOB_FINISHED = 70;
export const CTD_JOB_SETTLING = 71;

export function isCtdStatusCode(status: number): status is CtdStatusCode {
  return status in CtdStatusMap;
}

export function getCtdStatusText(status: CtdStatusCode): string {
  return CtdStatusMap[status];
}

export const DcpTransferState = {
  REQUESTED: 'REQUESTED',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  TERMINATED: 'TERMINATED',
  SUSPENDED: 'SUSPENDED',
} as const;

export type DcpTransferState =
  (typeof DcpTransferState)[keyof typeof DcpTransferState];

export const CtdToDcpStateMap: Record<CtdStatusCode, DcpTransferState> = {
  0: DcpTransferState.REQUESTED,
  1: DcpTransferState.REQUESTED,
  2: DcpTransferState.TERMINATED,
  10: DcpTransferState.STARTED,
  11: DcpTransferState.TERMINATED,
  12: DcpTransferState.STARTED,
  13: DcpTransferState.TERMINATED,
  14: DcpTransferState.TERMINATED,
  20: DcpTransferState.STARTED,
  21: DcpTransferState.TERMINATED,
  22: DcpTransferState.TERMINATED,
  30: DcpTransferState.STARTED,
  31: DcpTransferState.TERMINATED,
  32: DcpTransferState.TERMINATED,
  33: DcpTransferState.TERMINATED,
  40: DcpTransferState.STARTED,
  41: DcpTransferState.TERMINATED,
  42: DcpTransferState.TERMINATED,
  50: DcpTransferState.STARTED,
  60: DcpTransferState.STARTED,
  61: DcpTransferState.TERMINATED,
  62: DcpTransferState.TERMINATED,
  70: DcpTransferState.COMPLETED,
  // ocean-node sets 71 before it has written the job's outputs, so the job is not done yet.
  71: DcpTransferState.STARTED,
};

/**
 * DDO v5 only allows primitive values in `additionalInformation`, so nested values (e.g. the
 * Gaia-X information) are stored as JSON strings.
 */
export function toAdditionalInformation(
  info: object | undefined,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(info ?? {})) {
    if (value === undefined || value === null) continue;
    result[key] =
      typeof value === 'object' ? JSON.stringify(value) : (value as any);
  }
  return result;
}

/**
 * Typed value of a consumer parameter given as a string (the proto only carries strings):
 * DDO v5 and nautilus' userdata checks expect numbers and booleans as such.
 */
export function toConsumerParameterValue(
  type: string | undefined,
  value: string,
): string | number | boolean {
  if (type === 'number' && value.trim() !== '' && Number.isFinite(+value)) {
    return Number(value);
  }
  if (type === 'boolean' && (value === 'true' || value === 'false')) {
    return value === 'true';
  }
  return value;
}

type ProtoValue = {
  kind?: string;
  nullValue?: unknown;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: ProtoStruct;
  listValue?: { values?: ProtoValue[] };
};
type ProtoStruct = { fields?: Record<string, ProtoValue> };

const PROTO_VALUE_KINDS = [
  'stringValue',
  'numberValue',
  'boolValue',
  'structValue',
  'listValue',
  'nullValue',
] as const;

/**
 * A google.protobuf.Struct as @grpc/proto-loader decodes it (`{ fields: { key: { kind,
 * stringValue, ... } } }`), as plain JSON. Anything else is returned as it is.
 */
export function fromProtoStruct(struct: unknown): Record<string, unknown> {
  const fields = (struct as ProtoStruct)?.fields;
  if (!fields || typeof fields !== 'object') {
    return (struct ?? {}) as Record<string, unknown>;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, fromProtoValue(value)]),
  );
}

function fromProtoValue(value: ProtoValue): unknown {
  const kind =
    value?.kind ?? PROTO_VALUE_KINDS.find((k) => value?.[k] !== undefined);
  switch (kind) {
    case 'structValue':
      return fromProtoStruct(value.structValue);
    case 'listValue':
      return (value.listValue?.values ?? []).map(fromProtoValue);
    case 'nullValue':
      return null;
    case undefined:
      return value;
    default:
      return value[kind];
  }
}

/** `userdata` with each value converted to the type its consumer parameter declares. */
export function toUserdata(
  userdata: { [key: string]: string } | undefined,
  declared: { name: string; type: string }[] | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!userdata || Object.keys(userdata).length === 0) return undefined;

  const types = new Map((declared ?? []).map((p) => [p.name, p.type]));
  return Object.fromEntries(
    Object.entries(userdata).map(([key, value]) => [
      key,
      toConsumerParameterValue(types.get(key), value),
    ]),
  );
}

/**
 * The addresses of an asset's `address` entries in one credential list, which the policy
 * server reads as one list. Stored as bare strings or as `{ address }` objects.
 */
export function getCredentialAddresses(
  asset: AssetV5,
  list: CredentialListTypes,
): string[] {
  const credentials = asset.credentialSubject?.credentials as
    | DdoCredentials
    | undefined;
  return (credentials?.[list] ?? [])
    .filter(isAddressCredential)
    .flatMap((entry) => (Array.isArray(entry.values) ? entry.values : []))
    .flatMap((value) => {
      if (typeof value === 'string') return [value];
      return typeof value?.address === 'string' ? [value.address] : [];
    });
}
