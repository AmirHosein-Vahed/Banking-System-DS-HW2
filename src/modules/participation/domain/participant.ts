export type ParticipantOpType = 'debit' | 'credit';

export interface ParticipantOp {
  readonly type: ParticipantOpType;
  readonly accountId: string;
  readonly amount: number;
}

export type ParticipantState = 'PREPARING' | 'PREPARED' | 'COMMITTED' | 'ABORTED';

export interface ParticipantRecord {
  readonly txId: string;
  readonly gid: string;
  readonly shardId: string;
  readonly ops: readonly ParticipantOp[];
  readonly state: ParticipantState;
}

export type Vote =
  | { readonly vote: 'YES' }
  | { readonly vote: 'NO'; readonly code: string; readonly message: string };
