import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { CoordinatorService } from '../../src/modules/coordination/application/coordinator-service';
import type {
  CreateTxInput,
  ParticipantTransport,
  PrepareVoteResult,
  TxJournal,
} from '../../src/modules/coordination/application/ports';
import type { ParticipantOp } from '../../src/modules/participation/domain/participant';
import type { TxRecord } from '../../src/modules/coordination/domain/tx';
import { ShardMap, type ShardDefinition } from '../../src/modules/routing/domain/shard-map';
import { isAppError } from '../../src/shared/domain/errors';

const shards: ShardDefinition[] = [
  {
    id: 'A',
    ranges: [{ from: 'A0001', to: 'A1000' }],
    replicas: [{ id: 'a1', url: 'http://a1:8080' }],
  },
  {
    id: 'B',
    ranges: [{ from: 'A1001', to: 'A2000' }],
    replicas: [{ id: 'b1', url: 'http://b1:8080' }],
  },
];

const shardMap = new ShardMap(1, shards);
const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;

const clone = (tx: TxRecord): TxRecord => structuredClone(tx);

/** In-memory journal that mirrors the SQL journal's state transitions. */
class FakeJournal implements TxJournal {
  readonly records = new Map<string, TxRecord>();

  async create(input: CreateTxInput): Promise<{ record: TxRecord; created: boolean }> {
    for (const tx of this.records.values()) {
      if (tx.clientRequestId === input.clientRequestId) {
        return { record: clone(tx), created: false };
      }
    }
    const now = new Date().toISOString();
    const record: TxRecord = {
      txId: input.txId,
      clientRequestId: input.clientRequestId,
      from: input.from,
      to: input.to,
      amount: input.amount,
      status: 'INITIATED',
      version: 1,
      createdAt: now,
      updatedAt: now,
      participants: input.participants.map((participant) => ({
        shardId: participant.shardId,
        gid: participant.gid,
        vote: 'PENDING',
        ack: 'PENDING',
        attempts: 0,
      })),
    };
    this.records.set(input.txId, record);
    return { record: clone(record), created: true };
  }

  async get(txId: string): Promise<TxRecord | undefined> {
    const record = this.records.get(txId);
    return record === undefined ? undefined : clone(record);
  }

  async listUnresolved(limit: number): Promise<TxRecord[]> {
    return [...this.records.values()]
      .filter((tx) => tx.status !== 'COMPLETED')
      .slice(0, limit)
      .map(clone);
  }

  async markPreparing(txId: string): Promise<TxRecord> {
    const record = this.must(txId);
    if (record.status === 'INITIATED') {
      record.status = 'PREPARING';
      record.version += 1;
    }
    return clone(record);
  }

  async recordVote(txId: string, shardId: string, vote: 'PENDING' | 'YES' | 'NO', reason?: string) {
    const record = this.must(txId);
    const participant = record.participants.find((entry) => entry.shardId === shardId)!;
    participant.vote = vote;
    if (reason !== undefined) {
      participant.voteReason = reason;
    }
    if (record.status === 'PREPARING') {
      if (record.participants.some((entry) => entry.vote === 'NO')) {
        record.status = 'ABORT_DECIDED';
      } else if (record.participants.every((entry) => entry.vote === 'YES')) {
        record.status = 'PREPARED';
      }
    }
    record.version += 1;
    return clone(record);
  }

  async decide(txId: string): Promise<TxRecord> {
    const record = this.must(txId);
    if (record.status === 'PREPARED' && record.participants.every((entry) => entry.vote === 'YES')) {
      record.status = 'COMMIT_DECIDED';
    } else if (record.status === 'PREPARING' || record.status === 'PREPARED') {
      record.status = 'ABORT_DECIDED';
    }
    record.version += 1;
    return clone(record);
  }

  async markAck(txId: string, shardId: string): Promise<TxRecord> {
    const record = this.must(txId);
    const participant = record.participants.find((entry) => entry.shardId === shardId)!;
    participant.ack = 'DONE';
    if (
      record.participants.every((entry) => entry.ack === 'DONE') &&
      (record.status === 'COMMIT_DECIDED' || record.status === 'ABORT_DECIDED')
    ) {
      record.outcome = record.status === 'COMMIT_DECIDED' ? 'COMMITTED' : 'ABORTED';
      record.status = 'COMPLETED';
    }
    record.version += 1;
    return clone(record);
  }

  async recordAttemptError(): Promise<void> {}

  private must(txId: string): TxRecord {
    const record = this.records.get(txId);
    if (record === undefined) {
      throw new Error(`unknown transaction ${txId}`);
    }
    return record;
  }
}

class FakeTransport implements ParticipantTransport {
  readonly prepares: { shardId: string; txId: string; ops: readonly ParticipantOp[] }[] = [];
  readonly commits: string[] = [];
  readonly aborts: string[] = [];
  rejectOn: string | undefined;
  failOn: string | undefined;
  delayMs = 0;

  async prepare(
    shardId: string,
    txId: string,
    _gid: string,
    ops: readonly ParticipantOp[],
  ): Promise<PrepareVoteResult> {
    this.prepares.push({ shardId, txId, ops });
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failOn === shardId) {
      throw new Error(`connection refused to shard ${shardId}`);
    }
    if (this.rejectOn === shardId) {
      return { vote: 'NO', code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' };
    }
    return { vote: 'YES' };
  }

  async commit(shardId: string): Promise<void> {
    this.commits.push(shardId);
  }

  async abort(shardId: string): Promise<void> {
    this.aborts.push(shardId);
  }
}

function build(options: { rejectOn?: string; failOn?: string; delayMs?: number } = {}) {
  const journal = new FakeJournal();
  const transport = new FakeTransport();
  transport.rejectOn = options.rejectOn;
  transport.failOn = options.failOn;
  transport.delayMs = options.delayMs ?? 0;
  const service = new CoordinatorService(journal, transport, shardMap, undefined, logger);
  return { journal, transport, service };
}

describe('CoordinatorService', () => {
  it('commits when every participant votes YES', async () => {
    const { transport, service } = build();
    const tx = await service.transfer({
      clientRequestId: 'req-1',
      from: 'A0500',
      to: 'A1500',
      amount: 100,
    });

    expect(tx.status).toBe('COMPLETED');
    expect(tx.outcome).toBe('COMMITTED');
    expect(transport.commits.sort()).toEqual(['A', 'B']);
    expect(transport.aborts).toEqual([]);
    expect(tx.participants.every((p) => p.vote === 'YES' && p.ack === 'DONE')).toBe(true);
  });

  it('aborts both participants when the second one votes NO (scenario A)', async () => {
    const { transport, service } = build({ rejectOn: 'A' });
    const tx = await service.transfer({
      clientRequestId: 'req-2',
      from: 'A0500',
      to: 'A1500',
      amount: 1_000_000,
    });

    expect(tx.status).toBe('COMPLETED');
    expect(tx.outcome).toBe('ABORTED');
    expect(transport.commits).toEqual([]);
    expect(transport.aborts.sort()).toEqual(['A', 'B']);
    const rejected = tx.participants.find((p) => p.shardId === 'A');
    expect(rejected?.voteReason).toContain('INSUFFICIENT_FUNDS');
  });

  it('treats an unreachable participant as a NO vote', async () => {
    const { service } = build({ failOn: 'B' });
    const tx = await service.transfer({
      clientRequestId: 'req-3',
      from: 'A0500',
      to: 'A1500',
      amount: 10,
    });

    expect(tx.outcome).toBe('ABORTED');
    const unavailable = tx.participants.find((p) => p.shardId === 'B');
    expect(unavailable?.voteReason).toContain('UNAVAILABLE');
  });

  it('replays a completed transaction without another prepare round', async () => {
    const { transport, service } = build();
    const command = { clientRequestId: 'req-4', from: 'A0500', to: 'A1500', amount: 5 };
    const first = await service.transfer(command);
    const preparesAfterFirst = transport.prepares.length;

    const replay = await service.transfer(command);
    expect(replay.txId).toBe(first.txId);
    expect(transport.prepares.length).toBe(preparesAfterFirst);
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    const { service } = build();
    await service.transfer({ clientRequestId: 'req-5', from: 'A0500', to: 'A1500', amount: 5 });

    await expect(
      service.transfer({ clientRequestId: 'req-5', from: 'A0500', to: 'A1500', amount: 6 }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'IDEMPOTENCY_CONFLICT');
  });

  it('drives a transaction only once when request and recovery overlap', async () => {
    const { journal, transport, service } = build({ delayMs: 20 });
    const { record } = await journal.create({
      txId: 'tx-concurrent',
      clientRequestId: 'req-6',
      from: 'A0500',
      to: 'A1500',
      amount: 5,
      participants: [
        { shardId: 'B', gid: 'bank2pc:tx-concurrent:B' },
        { shardId: 'A', gid: 'bank2pc:tx-concurrent:A' },
      ],
    });

    const [first, second] = await Promise.all([
      service.drive(record.txId, false),
      service.drive(record.txId, false),
    ]);

    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    expect(transport.prepares).toHaveLength(2);
    expect(transport.commits).toHaveLength(2);
  });

  it('refuses same-shard transfers, which belong to the local path', async () => {
    const { service } = build();
    await expect(
      service.transfer({ clientRequestId: 'req-7', from: 'A0500', to: 'A0600', amount: 5 }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'VALIDATION_ERROR');
  });
});
