import {
  addCredentialAddresses,
  addRequestCredentials,
  type AssetV5,
  CredentialListTypes,
  type DdoCredentials,
  isAddressCredential,
  isSsiPolicyCredential,
  type License,
  type MatchRule,
  type RemoteObject,
  type RequestCredential,
  setVcPolicies,
  setVpPolicies,
  type VpPolicy,
} from '@deltadao/nautilus';
import {
  type AdditionalInformation,
  type LicenseDocument,
  type RequestCredential as ProtoRequestCredential,
  type SsiPolicy,
  SsiPolicy_MatchRule,
  type VpPolicy as ProtoVpPolicy,
} from '../generated/spp_v3.js';

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

// The tags of language-tagged values without a given language or direction, as nautilus'.
export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_DIRECTION = 'ltr';

// The Gaia-X compliance service the presentation of the Gaia-X SSI policy is checked by.
export const DEFAULT_GAIAX_EVP_URL =
  'https://www.delta-dao.com/compliance/v2/api/credential-offers/standard-compliance';

// The labels under which the reference DDO links its Gaia-X documents in `metadata.links`.
export const SERVICE_OFFERING_CREDENTIAL_LINK =
  'Digital Service Offering Credential';
export const SERVICE_CONTRACT_LINK = 'Service Contract';

/**
 * `metadata.additionalInformation` as the deltaDAO portal writes it:
 * `{ termsAndConditions, gaiaX: { serviceOfferingCredential } }`. The DDO v5 shape allows
 * nested objects there, though nautilus types it as primitives only.
 */
export function toAdditionalInformation(
  info: AdditionalInformation,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    termsAndConditions: Boolean(info.termsAndConditions),
  };
  const credential = info.gaiaX?.serviceOfferingCredential?.trim();
  if (credential) {
    result.gaiaX = { serviceOfferingCredential: credential };
  }
  return result;
}

/**
 * DDO v5 `license`: its name, by default the URL of the first document, and the documents
 * as remote objects. A hash is only written when given: nautilus computes none, and the
 * DDO v5 shape does not require one.
 */
export function toLicense(
  name: string | undefined,
  documents: LicenseDocument[],
): License {
  const licenseDocuments = documents.map((document, index) => {
    const url = document.url?.trim();
    if (!url) {
      throw new Error(`License document ${index} has no url`);
    }
    const remote: Record<string, unknown> = {
      name: url,
      mirrors: [{ type: 'url', method: 'get', url }],
    };
    if (document.fileType?.trim()) remote.fileType = document.fileType.trim();
    const sha256 = document.sha256?.trim();
    if (sha256) {
      if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
        throw new Error(
          `License document ${url}: sha256 '${sha256}' is not 64 hex characters`,
        );
      }
      remote.sha256 = sha256.toLowerCase();
    }
    return remote as unknown as RemoteObject;
  });
  return {
    name: name?.trim() || licenseDocuments[0]?.name || '',
    ...(licenseDocuments.length ? { licenseDocuments } : {}),
  };
}

/** The Gaia-X participant policy of the reference DDO; `evpUrl` checks the presentation. */
export function gaiaXSsiPolicy(evpUrl: string) {
  const types = [
    'gx:LegalPerson',
    'gx:Issuer',
    'gx:VatID',
    'gx:LeiCode',
    'gx:EORI',
  ];
  return {
    requestCredentials: types.map(
      (type): RequestCredential => ({
        type,
        format: 'jwt_vc_json',
        policies: [],
      }),
    ),
    vcPolicies: ['signature'],
    vpPolicies: [
      { policy: 'minimum-credentials', args: '3' },
      { policy: 'external-evp-forward', args: evpUrl },
      {
        policy: 'vp_required_credentials',
        args: JSON.stringify({
          required: [
            { credential_type: 'gx:LegalPerson' },
            { credential_type: 'gx:Issuer' },
            { any_of: ['gx:EORI', 'gx:LeiCode', 'gx:VatID'] },
          ],
        }),
      },
    ] as VpPolicy[],
    matchDeny: 'any' as MatchRule,
  };
}

const MATCH_RULES: Record<number, MatchRule | undefined> = {
  [SsiPolicy_MatchRule.ANY]: 'any',
  [SsiPolicy_MatchRule.ALL]: 'all',
};

/**
 * Replaces the `SSIpolicy` entry of the allow list with the given policy, keeping the
 * address and access list entries. A policy without request credentials removes the entry:
 * the policy server refuses an SSIpolicy that asks for none. An allow list without address
 * entry gets `*`, as the policy server combines all allow rules.
 */
export function applySsiPolicy(
  credentials: DdoCredentials | undefined,
  policy: SsiPolicy,
  evpUrl: string,
): DdoCredentials {
  const preset = policy.gaiaX ? gaiaXSsiPolicy(evpUrl) : undefined;
  const requestCredentials = [
    ...(preset?.requestCredentials ?? []),
    ...(policy.requestCredentials ?? []).map(toRequestCredential),
  ];
  const vcPolicies = [
    ...(preset?.vcPolicies ?? []),
    ...(policy.vcPolicies ?? []).map((name) => name.trim()).filter(Boolean),
  ];
  const vpPolicies = [
    ...(preset?.vpPolicies ?? []),
    ...(policy.vpPolicies ?? []).map(toVpPolicy),
  ];

  let result: DdoCredentials = {
    ...credentials,
    allow: (credentials?.allow ?? []).filter(
      (entry) => !isSsiPolicyCredential(entry),
    ),
  };
  if (requestCredentials.length) {
    result = addRequestCredentials(
      result,
      CredentialListTypes.ALLOW,
      requestCredentials,
    );
    result = setVcPolicies(result, CredentialListTypes.ALLOW, vcPolicies);
    result = setVpPolicies(result, CredentialListTypes.ALLOW, vpPolicies);
    if (!result.allow.some(isAddressCredential)) {
      result = addCredentialAddresses(result, CredentialListTypes.ALLOW, ['*']);
    }
  } else if (vcPolicies.length || vpPolicies.length) {
    throw new Error(
      'An SSI policy with VC or VP policies needs request credentials (or gaiaX)',
    );
  }

  const matchAllow = MATCH_RULES[policy.matchAllow];
  const matchDeny = MATCH_RULES[policy.matchDeny] ?? preset?.matchDeny;
  if (matchAllow) result.match_allow = matchAllow;
  if (matchDeny) result.match_deny = matchDeny;
  return result;
}

function toRequestCredential(credential: ProtoRequestCredential) {
  const type = credential.type?.trim();
  if (!type) {
    throw new Error('A request credential of the SSI policy has no type');
  }
  const result: RequestCredential = {
    type,
    policies: credential.policies ?? [],
  };
  if (credential.format?.trim()) result.format = credential.format.trim();
  return result;
}

function toVpPolicy(vpPolicy: ProtoVpPolicy): VpPolicy {
  const policy = vpPolicy.policy?.trim();
  if (!policy) {
    throw new Error('A VP policy of the SSI policy has no name');
  }
  return vpPolicy.args !== undefined
    ? { policy, args: vpPolicy.args }
    : { policy };
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
