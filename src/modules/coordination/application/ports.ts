import type { Ack, TxRecord, Vote } from '../domain/tx';
import type { ParticipantOp } from '../../participation/domain/participant';

export interface CreateTxInput {
  readonly txId: string;
  readonly clientRequestId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly participants: readonly { readonly shardId: string; readonly gid: string }[];
}

export type PrepareVoteResult =
  | { readonly vote: 'YES' }
  | { readonly vote: 'NO'; readonly code: string; readonly message: string };

export interface ParticipantTransport {
  prepare(
    shardId: string,
    txId: string,
    gid: string,
    ops: readonly ParticipantOp[],
  ): Promise<PrepareVoteResult>;
  commit(shardId: string, txId: string, gid: string): Promise<void>;
  abort(shardId: string, txId: string, gid: string): Promise<void>;
}

export interface TxJournal {
  create(input: CreateTxInput): Promise<{ record: TxRecord; created: boolean }>;
  get(txId: string): Promise<TxRecord | undefined>;
  listUnresolved(limit: number): Promise<TxRecord[]>;
  markPreparing(txId: string): Promise<TxRecord>;
  recordVote(txId: string, shardId: string, vote: Vote, reason?: string): Promise<TxRecord>;
  decide(txId: string): Promise<TxRecord>;
  markAck(txId: string, shardId: string): Promise<TxRecord>;
  recordAttemptError(txId: string, shardId: string, message: string): Promise<void>;
}

export interface FaultInjector {
  afterPrepare(txId: string): Promise<void>;
  afterDecision(txId: string, decision: 'COMMIT_DECIDED' | 'ABORT_DECIDED'): Promise<void>;
}

export class NoopFaultInjector implements FaultInjector {
  async afterPrepare(): Promise<void> {}
  async afterDecision(): Promise<void> {}
}

export function isTerminal(status: TxRecord['status']): boolean {
  return status === 'COMPLETED';
}

export type { Ack, Vote };
