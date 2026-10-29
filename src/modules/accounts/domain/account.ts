export interface AccountBalance {
  readonly accountId: string;
  readonly balance: number;
}

export interface LocalTransferResult {
  readonly from: AccountBalance;
  readonly to: AccountBalance;
}

export interface DepositCommand {
  readonly accountId: string;
  readonly amount: number;
  readonly requestId: string;
  readonly payloadHash: string;
}

export type WithdrawCommand = DepositCommand;

export interface LocalTransferCommand {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly requestId: string;
  readonly payloadHash: string;
}
