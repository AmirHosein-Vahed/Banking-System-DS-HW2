import type { Logger } from 'pino';
import { newId, gidFor } from '../../../shared/domain/ids';
import { assertAccountId, parseAmount } from '../../../shared/domain/money';
import {
  AppError,
  idempotencyConflict,
  isAppError,
  txNotFound,
  validationError,
} from '../../../shared/domain/errors';
import type { ShardMap } from '../../routing/domain/shard-map';
import type { ParticipantOp } from '../../participation/domain/participant';
import type { ParticipantTransport, TxJournal } from '../application/ports';
import type { FaultInjector } from '../application/ports';
import type { TxRecord, TxView } from '../domain/tx';
import { toView } from '../domain/tx';
import { KeyedMutex } from '../../../shared/infra/keyed-mutex';

export interface TransferCommand {
  readonly clientRequestId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

export class CoordinatorService {
  private readonly txLocks = new KeyedMutex();
  private readonly accountLocks = new KeyedMutex();

  constructor(
    private readonly journal: TxJournal,
    private readonly transport: ParticipantTransport,
    private readonly shardMap: ShardMap,
    private readonly faults: FaultInjector | undefined,
    private readonly logger: Logger,
  ) {}

  async transfer(command: TransferCommand): Promise<TxRecord> {
    const from = assertAccountId(command.from);
    const to = assertAccountId(command.to);
    const amount = parseAmount(command.amount);
    if (from === to) {
      throw validationError('from and to must be different accounts');
    }
    const fromShard = this.shardMap.resolve(from);
    const toShard = this.shardMap.resolve(to);
    if (fromShard.id === toShard.id) {
      throw validationError('same-shard transfers must be executed as a local transaction');
    }

    // A prepared transaction keeps the row locks of the accounts it touched
    // until phase two resolves it. Two concurrent transfers that share an
    // account therefore block each other inside PostgreSQL and, under load,
    // can exhaust the participant connection pools. Serialising per account
    // in the coordinator (in sorted order, like the row-lock order) keeps the
    // database work short while transfers between disjoint accounts still run
    // fully in parallel.
    return this.accountLocks.runMany([from, to], async () => {
      const txId = newId();
      const { record, created } = await this.journal.create({
        txId,
        clientRequestId: command.clientRequestId,
        from,
        to,
        amount,
        participants: [
          { shardId: toShard.id, gid: gidFor(txId, toShard.id) },
          { shardId: fromShard.id, gid: gidFor(txId, fromShard.id) },
        ],
      });

      if (record.from !== from || record.to !== to || record.amount !== amount) {
        throw idempotencyConflict(command.clientRequestId);
      }

      if (!created && record.status === 'COMPLETED') {
        return record;
      }

      this.logger.info(
        { event: 'tx.begin', txId: record.txId, from, to, amount, created },
        'distributed transfer accepted',
      );
      return this.drive(record.txId, true);
    });
  }

  async get(txId: string): Promise<TxRecord> {
    const record = await this.journal.get(txId);
    if (record === undefined) {
      throw txNotFound(txId);
    }
    return record;
  }

  async view(txId: string): Promise<TxView> {
    return toView(await this.get(txId));
  }

  /**
   * Idempotent state-machine driver. The recovery path calls it with
   * allowFaults=false so demo fault hooks can never crash a recovering node.
   *
   * Every call is serialised per transaction id, which means a client request
   * and a concurrent recovery sweep can never both prepare, decide or
   * acknowledge the same transaction.
   */
  async drive(txId: string, allowFaults: boolean): Promise<TxRecord> {
    return this.txLocks.run(txId, () => this.driveExclusive(txId, allowFaults));
  }

  private async driveExclusive(txId: string, allowFaults: boolean): Promise<TxRecord> {
    let tx = await this.get(txId);

    if (tx.status === 'COMPLETED') {
      return tx;
    }

    if (tx.status === 'INITIATED') {
      tx = await this.journal.markPreparing(txId);
      this.logger.info({ event: 'tx.phase', txId, phase: tx.status }, 'transaction preparing');
    }

    if (tx.status === 'PREPARING') {
      tx = await this.prepareAll(tx);
      if (tx.status === 'PREPARING') {
        // No decisive vote was durably recorded; aborting is always safe.
        tx = await this.journal.decide(txId);
      }
      if (tx.status === 'PREPARED' && allowFaults) {
        await this.faults?.afterPrepare(txId);
      }
      this.logger.info({ event: 'tx.phase', txId, phase: tx.status }, 'prepare phase finished');
    }

    if (tx.status === 'PREPARED') {
      tx = await this.journal.decide(txId);
      this.logger.info(
        { event: 'tx.decision', txId, decision: tx.status },
        'durable decision recorded',
      );
      if (allowFaults) {
        await this.faults?.afterDecision(
          txId,
          tx.status === 'COMMIT_DECIDED' ? 'COMMIT_DECIDED' : 'ABORT_DECIDED',
        );
      }
    }

    if (tx.status === 'COMMIT_DECIDED' || tx.status === 'ABORT_DECIDED') {
      tx = await this.phase2(tx);
    }

    if (tx.status === 'COMPLETED') {
      this.logger.info(
        { event: 'tx.completed', txId, outcome: tx.outcome },
        'distributed transaction completed',
      );
    } else {
      this.logger.warn(
        { event: 'tx.pending', txId, phase: tx.status },
        'distributed transaction left for the resolver',
      );
    }
    return tx;
  }

  async resolveOnce(limit = 50): Promise<number> {
    const unresolved = await this.journal.listUnresolved(limit);
    for (const tx of unresolved) {
      try {
        await this.drive(tx.txId, false);
      } catch (error) {
        this.logger.error(
          { event: 'tx.recovery_failed', txId: tx.txId, err: error },
          'recovery attempt failed; will retry',
        );
      }
    }
    return unresolved.length;
  }

  private async prepareAll(tx: TxRecord): Promise<TxRecord> {
    let current = tx;
    for (const participant of tx.participants) {
      if (participant.vote !== 'PENDING') {
        continue;
      }
      const ops = this.opsFor(tx, participant.shardId);
      try {
        const result = await this.transport.prepare(
          participant.shardId,
          tx.txId,
          participant.gid,
          ops,
        );
        current = await this.journal.recordVote(
          tx.txId,
          participant.shardId,
          result.vote,
          result.vote === 'NO' ? `${result.code}: ${result.message}` : undefined,
        );
        this.logger.info(
          {
            event: 'tx.vote',
            txId: tx.txId,
            shard: participant.shardId,
            vote: result.vote,
            ...(result.vote === 'NO' ? { code: result.code } : {}),
          },
          'prepare vote recorded',
        );
      } catch (error) {
        const message = isAppError(error) ? `${error.code}: ${error.message}` : String(error);
        current = await this.journal.recordVote(
          tx.txId,
          participant.shardId,
          'NO',
          `UNAVAILABLE: ${message}`,
        );
        this.logger.warn(
          { event: 'tx.vote', txId: tx.txId, shard: participant.shardId, vote: 'NO', err: error },
          'participant unavailable; voting NO',
        );
      }
      if (current.status === 'ABORT_DECIDED') {
        break;
      }
    }
    return current;
  }

  private async phase2(tx: TxRecord): Promise<TxRecord> {
    const committing = tx.status === 'COMMIT_DECIDED';
    let current = tx;
    for (const participant of tx.participants) {
      if (participant.ack === 'DONE') {
        continue;
      }
      try {
        if (committing) {
          await this.transport.commit(participant.shardId, tx.txId, participant.gid);
        } else {
          await this.transport.abort(participant.shardId, tx.txId, participant.gid);
        }
        current = await this.journal.markAck(tx.txId, participant.shardId);
        this.logger.info(
          {
            event: 'tx.ack',
            txId: tx.txId,
            shard: participant.shardId,
            phase: committing ? 'commit' : 'abort',
          },
          'participant acknowledged',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.journal.recordAttemptError(tx.txId, participant.shardId, message);
        this.logger.warn(
          {
            event: 'tx.ack_failed',
            txId: tx.txId,
            shard: participant.shardId,
            phase: committing ? 'commit' : 'abort',
            err: error,
          },
          'participant did not acknowledge; resolver will retry',
        );
      }
    }
    return current;
  }

  private opsFor(tx: TxRecord, shardId: string): readonly ParticipantOp[] {
    const fromShard = this.shardMap.resolve(tx.from);
    if (fromShard.id === shardId) {
      return [{ type: 'debit', accountId: tx.from, amount: tx.amount }];
    }
    const toShard = this.shardMap.resolve(tx.to);
    if (toShard.id !== shardId) {
      throw new AppError('INTERNAL_ERROR', `Shard ${shardId} is not a participant of ${tx.txId}`);
    }
    return [{ type: 'credit', accountId: tx.to, amount: tx.amount }];
  }
}
