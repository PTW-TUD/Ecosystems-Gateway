//import { KeyObject } from 'crypto';

export function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

export const CtdStatusMap = {
  1: 'Warming up',
  10: 'Job started',
  20: 'Configuring volumes',
  30: 'Provisioning success',
  31: 'Data provisioning failed',
  32: 'Algorithm provisioning failed',
  40: 'Running algorithm',
  50: 'Filtering results',
  60: 'Publishing results',
  70: 'Job completed',
} as const;

export type CtdStatusCode = keyof typeof CtdStatusMap;

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
  1: DcpTransferState.REQUESTED,
  10: DcpTransferState.STARTED,
  20: DcpTransferState.STARTED,
  30: DcpTransferState.STARTED,
  31: DcpTransferState.TERMINATED,
  32: DcpTransferState.TERMINATED,
  40: DcpTransferState.STARTED,
  50: DcpTransferState.STARTED,
  60: DcpTransferState.STARTED,
  70: DcpTransferState.COMPLETED,
};
