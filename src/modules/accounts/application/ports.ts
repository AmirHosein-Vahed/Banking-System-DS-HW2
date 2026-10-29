import type {
  AccountBalance,
  DepositCommand,
  LocalTransferCommand,
  LocalTransferResult,
  WithdrawCommand,
} from '../domain/account';

export interface AccountStore {
  getBalance(accountId: string): Promise<AccountBalance>;
  deposit(command: DepositCommand): Promise<AccountBalance>;
  withdraw(command: WithdrawCommand): Promise<AccountBalance>;
  transferLocal(command: LocalTransferCommand): Promise<LocalTransferResult>;
}
