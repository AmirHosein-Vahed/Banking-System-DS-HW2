import type { Pool, PoolClient } from 'pg';
import type { ShardMap } from '../../routing/domain/shard-map';
import type { ParticipantOp, Vote } from '../domain/participant';
import { PgParticipantJournal } from '../adapters/pg-participant-journal';
import { PgPreparedXact } from '../adapters/pg-prepared-xact';
import {
  AppError,
  accountNotFound,
  insufficientFunds,
  isAppError,
  txNotFound,
  validationError,
} from '../../../shared/domain/errors';
import { assertAccountId, parseAmount } from '../../../shared/domain/money';
import { assertGid, gidFor } from '../../../shared/domain/ids';
import { Semaphore } from '../../../shared/infra/semaphore';

export interface ParticipantServiceOptions {
  readonly pool: Pool;
  readonly shardId: string;
  readonly shardMap: ShardMap;
  /**
   * Upper bound on prepares that may hold a pool connection at the same time.
   * Resolution (commit/abort) always keeps the remaining connections.
   */
  readonly maxConcurrentPrepares?: number;
}

/** PostgreSQL lock/deadlock/cancellation errors that simply mean "try later". */
const CONTENTION_SQLSTATES = new Set(['55P03', '40P01', '57014']);

function isContentionError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    CONTENTION_SQLSTATES.has((error as { code: string }).code)
  );
}

export class ParticipantService {
  private readonly journal: PgParticipantJournal;
  private readonly prepared: PgPreparedXact;
  private readonly prepareSlots: Semaphore;

  constructor(private readonly options: ParticipantServiceOptions) {
    this.journal = new PgParticipantJournal(options.pool);
    this.prepared = new PgPreparedXact(options.pool);
    const poolSize = options.pool.options.max ?? 10;
    this.prepareSlots = new Semaphore(
      options.maxConcurrentPrepares ?? Math.max(2, poolSize - 3),
    );
  }

  async prepare(txId: string, gid: string, shardId: string, ops: readonly ParticipantOp[]): Promise<Vote> {
    this.validateRequest(txId, gid, shardId, ops);

    return this.prepareSlots.run(() =>
      this.journal.withLock(txId, async (client) => {
        const row = await this.journal.get(client, txId);

        if (row !== undefined) {
          if (row.state === 'ABORTED') {
            return { vote: 'NO', code: 'TX_ABORTED', message: 'Transaction was aborted' };
          }
          if (row.state === 'COMMITTED') {
            return { vote: 'YES' };
          }
          if (row.state === 'PREPARED') {
            // The participant never resolves prepared transactions on its own.
            // If the GID is gone, the coordinator must have already committed it.
            return { vote: 'YES' };
          }
          if (row.state === 'PREPARING' && (await this.prepared.exists(gid, client))) {
            await this.journal.setState(client, txId, 'PREPARED');
            return { vote: 'YES' };
          }
        }

        await this.journal.upsertPreparing(client, { txId, gid, shardId, ops });

        await client.query('BEGIN');
        try {
          // A prepare that waits for a row lock would pin this connection and
          // can starve the pool. Fail fast instead and let the coordinator
          // abort; the client may retry with a new idempotency key.
          await client.query('SET LOCAL lock_timeout = 2000');
          await this.applyOps(client, txId, ops);
          await client.query(`PREPARE TRANSACTION '${assertGid(gid)}'`);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          await this.journal.setState(client, txId, 'ABORTED');
          if (isAppError(error)) {
            return { vote: 'NO', code: error.code, message: error.message };
          }
          if (isContentionError(error)) {
            return {
              vote: 'NO',
              code: 'CONTENTION',
              message: `Participant could not lock the accounts: ${error.message}`,
            };
          }
          throw error;
        }

        await this.journal.setState(client, txId, 'PREPARED');
        return { vote: 'YES' };
      }),
    );
  }

  async commit(txId: string, gid: string): Promise<void> {
    assertGid(gid);
    await this.journal.withLock(txId, async (client) => {
      const row = await this.journal.get(client, txId);
      if (row === undefined) {
        throw txNotFound(txId);
      }
      if (row.state === 'ABORTED') {
        throw new AppError('TX_CONFLICT', `Transaction ${txId} was already aborted`, 409);
      }
      if (await this.prepared.exists(gid, client)) {
        await this.prepared.commit(gid, client);
      }
      await this.journal.setState(client, txId, 'COMMITTED');
    });
  }

  async abort(txId: string, gid: string): Promise<void> {
    assertGid(gid);
    await this.journal.withLock(txId, async (client) => {
      const row = await this.journal.get(client, txId);
      if (row?.state === 'COMMITTED') {
        throw new AppError(
          'TX_CONFLICT',
          `Transaction ${txId} was already committed and cannot be aborted`,
          409,
        );
      }
      if (row === undefined) {
        await this.journal.upsertAborted(client, {
          txId,
          gid,
          shardId: this.options.shardId,
        });
      } else {
        await this.journal.setState(client, txId, 'ABORTED');
      }
      if (await this.prepared.exists(gid, client)) {
        await this.prepared.rollback(gid, client);
      }
    });
  }

  async getState(txId: string): Promise<string | undefined> {
    return this.journal.withLock(txId, async (client) => {
      const row = await this.journal.get(client, txId);
      return row?.state;
    });
  }

  private validateRequest(
    txId: string,
    gid: string,
    shardId: string,
    ops: readonly ParticipantOp[],
  ): void {
    if (txId.length === 0 || txId.length > 120) {
      throw validationError('txId is invalid');
    }
    if (shardId !== this.options.shardId) {
      throw validationError(`Participant shard must be ${this.options.shardId}`);
    }
    if (gid !== gidFor(txId, shardId)) {
      throw validationError('gid does not match txId and shardId');
    }
    if (ops.length === 0) {
      throw validationError('participant ops must not be empty');
    }
    for (const op of ops) {
      if (op.type !== 'debit' && op.type !== 'credit') {
        throw validationError('op type must be debit or credit');
      }
      assertAccountId(op.accountId);
      parseAmount(op.amount);
      this.options.shardMap.assertOwns(this.options.shardId, op.accountId);
    }
  }

  private async applyOps(
    client: PoolClient,
    txId: string,
    ops: readonly ParticipantOp[],
  ): Promise<void> {
    for (const op of ops) {
      if (op.type === 'debit') {
        const updated = await client.query<{ balance: string }>(
          `UPDATE accounts
           SET balance = balance - $2, version = version + 1, updated_at = now()
           WHERE account_id = $1 AND balance >= $2
           RETURNING balance`,
          [op.accountId, op.amount],
        );
        if (updated.rowCount === 0) {
          const exists = await client.query('SELECT 1 FROM accounts WHERE account_id = $1', [
            op.accountId,
          ]);
          if (exists.rowCount === 0) {
            throw accountNotFound(op.accountId);
          }
          throw insufficientFunds(op.accountId);
        }
      } else {
        const updated = await client.query(
          `UPDATE accounts
           SET balance = balance + $2, version = version + 1, updated_at = now()
           WHERE account_id = $1`,
          [op.accountId, op.amount],
        );
        if (updated.rowCount === 0) {
          throw accountNotFound(op.accountId);
        }
      }
      await client.query(
        `INSERT INTO ledger_entries (tx_id, account_id, delta, reason)
         VALUES ($1, $2, $3, 'transfer')`,
        [txId, op.accountId, op.type === 'debit' ? -op.amount : op.amount],
      );
    }
  }
}
