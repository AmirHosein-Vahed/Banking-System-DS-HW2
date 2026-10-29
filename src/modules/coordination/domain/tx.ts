export type TxStatus =
  | 'INITIATED'
  | 'PREPARING'
  | 'PREPARED'
  | 'COMMIT_DECIDED'
  | 'ABORT_DECIDED'
  | 'COMPLETED';

export type TxOutcome = 'COMMITTED' | 'ABORTED';
export type Vote = 'PENDING' | 'YES' | 'NO';
export type Ack = 'PENDING' | 'DONE';

export const ALLOWED_TRANSITIONS: Readonly<Record<TxStatus, readonly TxStatus[]>> = {
  INITIATED: ['PREPARING'],
  PREPARING: ['PREPARED', 'ABORT_DECIDED'],
  PREPARED: ['COMMIT_DECIDED'],
  COMMIT_DECIDED: ['COMPLETED'],
  ABORT_DECIDED: ['COMPLETED'],
  COMPLETED: [],
};

export function canTransition(from: TxStatus, to: TxStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ParticipantRecord {
  readonly shardId: string;
  readonly gid: string;
  readonly vote: Vote;
  readonly voteReason?: string;
  readonly ack: Ack;
  readonly attempts: number;
  readonly lastError?: string;
}

export interface TxRecord {
  readonly txId: string;
  readonly clientRequestId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly status: TxStatus;
  readonly outcome?: TxOutcome;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt?: string;
  readonly completedAt?: string;
  readonly participants: readonly ParticipantRecord[];
}

export interface TxView {
  readonly txId: string;
  readonly status: 'PENDING' | 'COMPLETED';
  readonly phase: TxStatus;
  readonly outcome?: TxOutcome;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly votes: Readonly<Record<string, Vote>>;
  readonly acks: Readonly<Record<string, Ack>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toView(tx: TxRecord): TxView {
  return {
    txId: tx.txId,
    status: tx.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
    phase: tx.status,
    ...(tx.outcome === undefined ? {} : { outcome: tx.outcome }),
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    votes: Object.fromEntries(tx.participants.map((participant) => [participant.shardId, participant.vote])),
    acks: Object.fromEntries(tx.participants.map((participant) => [participant.shardId, participant.ack])),
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };
}
