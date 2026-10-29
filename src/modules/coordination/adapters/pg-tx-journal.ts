import type { Pool } from 'pg';
import type { CreateTxInput, TxJournal } from '../application/ports';
import type { Ack, ParticipantRecord, TxOutcome, TxRecord, TxStatus, Vote } from '../domain/tx';
import { AppError } from '../../../shared/domain/errors';

interface TxRow {
  tx_id: string;
  client_request_id: string;
  from_account: string;
  to_account: string;
  amount: string;
  status: TxStatus;
  outcome: TxOutcome | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
  completed_at: Date | null;
}

interface ParticipantRow {
  shard_id: string;
  gid: string;
  vote: Vote;
  vote_reason: string | null;
  ack: Ack;
  attempts: number;
  last_error: string | null;
}

const TX_COLUMNS = `tx_id, client_request_id, from_account, to_account, amount,
  status, outcome, version, created_at, updated_at, decided_at, completed_at`;

export class PgTxJournal implements TxJournal {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateTxInput): Promise<{ record: TxRecord; created: boolean }> {
    const client = await this.pool.connect();
    let resolvedId: string | null = null;
    let created = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        input.clientRequestId,
      ]);
      const existing = await client.query<{ tx_id: string }>(
        'SELECT tx_id FROM transactions WHERE client_request_id = $1',
        [input.clientRequestId],
      );
      const existingId = existing.rows[0]?.tx_id;
      if (existingId !== undefined) {
        await client.query('COMMIT');
        resolvedId = existingId;
      } else {
        await client.query(
          `INSERT INTO transactions (tx_id, client_request_id, from_account, to_account, amount, status)
           VALUES ($1, $2, $3, $4, $5, 'INITIATED')`,
          [input.txId, input.clientRequestId, input.from, input.to, input.amount],
        );
        for (const participant of input.participants) {
          await client.query(
            `INSERT INTO participants (tx_id, shard_id, gid) VALUES ($1, $2, $3)`,
            [input.txId, participant.shardId, participant.gid],
          );
        }
        await client.query(
          `INSERT INTO tx_events (tx_id, from_status, to_status, detail)
           VALUES ($1, NULL, 'INITIATED', $2::jsonb)`,
          [input.txId, JSON.stringify({ participants: input.participants.map((p) => p.shardId) })],
        );
        await client.query('COMMIT');
        resolvedId = input.txId;
        created = true;
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (resolvedId === null) {
      throw new AppError('INTERNAL_ERROR', 'Transaction was not persisted');
    }
    const record = await this.get(resolvedId);
    if (record === undefined) {
      throw new AppError('INTERNAL_ERROR', `Transaction ${resolvedId} disappeared`);
    }
    return { record, created };
  }

  async get(txId: string): Promise<TxRecord | undefined> {
    const txResult = await this.pool.query<TxRow>(
      `SELECT ${TX_COLUMNS} FROM transactions WHERE tx_id = $1`,
      [txId],
    );
    const row = txResult.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const participantsResult = await this.pool.query<ParticipantRow>(
      `SELECT shard_id, gid, vote, vote_reason, ack, attempts, last_error
       FROM participants WHERE tx_id = $1 ORDER BY shard_id`,
      [txId],
    );
    return mapTx(row, participantsResult.rows);
  }

  async listUnresolved(limit: number): Promise<TxRecord[]> {
    const result = await this.pool.query<{ tx_id: string }>(
      `SELECT tx_id FROM transactions WHERE status <> 'COMPLETED'
       ORDER BY created_at LIMIT $1`,
      [limit],
    );
    const records: TxRecord[] = [];
    for (const row of result.rows) {
      const record = await this.get(row.tx_id);
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records;
  }

  async markPreparing(txId: string): Promise<TxRecord> {
    await this.transition(txId, {
      from: ['INITIATED'],
      to: 'PREPARING',
      detail: {},
    });
    const record = await this.get(txId);
    if (record === undefined) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
    }
    return record;
  }

  async recordVote(txId: string, shardId: string, vote: Vote, reason?: string): Promise<TxRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<TxRow>(
        `SELECT ${TX_COLUMNS} FROM transactions WHERE tx_id = $1 FOR UPDATE`,
        [txId],
      );
      if (tx.rows[0] === undefined) {
        throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
      }
      await client.query(
        `UPDATE participants SET vote = $3, vote_reason = $4, updated_at = now()
         WHERE tx_id = $1 AND shard_id = $2`,
        [txId, shardId, vote, reason ?? null],
      );
      const participants = await client.query<ParticipantRow>(
        `SELECT shard_id, gid, vote, vote_reason, ack, attempts, last_error
         FROM participants WHERE tx_id = $1 ORDER BY shard_id`,
        [txId],
      );
      const current = tx.rows[0]!;
      let next: TxStatus | undefined;
      if (current.status === 'PREPARING') {
        if (participants.rows.some((participant) => participant.vote === 'NO')) {
          next = 'ABORT_DECIDED';
        } else if (
          participants.rows.length > 0 &&
          participants.rows.every((participant) => participant.vote === 'YES')
        ) {
          next = 'PREPARED';
        }
      }
      if (next !== undefined) {
        await client.query(
          `UPDATE transactions
           SET status = $2, version = version + 1, updated_at = now(),
               decided_at = CASE WHEN $2 IN ('COMMIT_DECIDED','ABORT_DECIDED') THEN now() ELSE decided_at END
           WHERE tx_id = $1`,
          [txId, next],
        );
        await client.query(
          `INSERT INTO tx_events (tx_id, from_status, to_status, detail)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [txId, current.status, next, JSON.stringify({ shardId, vote, reason })],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const record = await this.get(txId);
    if (record === undefined) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
    }
    return record;
  }

  async decide(txId: string): Promise<TxRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<TxRow>(
        `SELECT ${TX_COLUMNS} FROM transactions WHERE tx_id = $1 FOR UPDATE`,
        [txId],
      );
      const current = tx.rows[0];
      if (current === undefined) {
        throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
      }
      if (current.status === 'COMMIT_DECIDED' || current.status === 'ABORT_DECIDED' || current.status === 'COMPLETED') {
        await client.query('COMMIT');
      } else {
        const participants = await client.query<{ vote: Vote }>(
          'SELECT vote FROM participants WHERE tx_id = $1',
          [txId],
        );
        const allYes =
          participants.rows.length > 0 && participants.rows.every((row) => row.vote === 'YES');
        const next: TxStatus = current.status === 'PREPARED' && allYes ? 'COMMIT_DECIDED' : 'ABORT_DECIDED';
        await client.query(
          `UPDATE transactions
           SET status = $2, version = version + 1, updated_at = now(), decided_at = now()
           WHERE tx_id = $1`,
          [txId, next],
        );
        await client.query(
          `INSERT INTO tx_events (tx_id, from_status, to_status, detail)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [txId, current.status, next, JSON.stringify({ allYes })],
        );
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const record = await this.get(txId);
    if (record === undefined) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
    }
    return record;
  }

  async markAck(txId: string, shardId: string): Promise<TxRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<TxRow>(
        `SELECT ${TX_COLUMNS} FROM transactions WHERE tx_id = $1 FOR UPDATE`,
        [txId],
      );
      const current = tx.rows[0];
      if (current === undefined) {
        throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
      }
      await client.query(
        `UPDATE participants SET ack = 'DONE', updated_at = now()
         WHERE tx_id = $1 AND shard_id = $2`,
        [txId, shardId],
      );
      const participants = await client.query<{ ack: Ack }>(
        'SELECT ack FROM participants WHERE tx_id = $1',
        [txId],
      );
      const allDone =
        participants.rows.length > 0 && participants.rows.every((row) => row.ack === 'DONE');
      if (
        allDone &&
        (current.status === 'COMMIT_DECIDED' || current.status === 'ABORT_DECIDED')
      ) {
        const outcome: TxOutcome = current.status === 'COMMIT_DECIDED' ? 'COMMITTED' : 'ABORTED';
        await client.query(
          `UPDATE transactions
           SET status = 'COMPLETED', outcome = $2, version = version + 1,
               updated_at = now(), completed_at = now()
           WHERE tx_id = $1`,
          [txId, outcome],
        );
        await client.query(
          `INSERT INTO tx_events (tx_id, from_status, to_status, detail)
           VALUES ($1, $2, 'COMPLETED', $3::jsonb)`,
          [txId, current.status, JSON.stringify({ outcome })],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const record = await this.get(txId);
    if (record === undefined) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
    }
    return record;
  }

  async recordAttemptError(txId: string, shardId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE participants
       SET attempts = attempts + 1, last_error = $3, updated_at = now()
       WHERE tx_id = $1 AND shard_id = $2`,
      [txId, shardId, message.slice(0, 500)],
    );
  }

  private async transition(
    txId: string,
    options: { from: TxStatus[]; to: TxStatus; detail: Record<string, unknown> },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<TxRow>(
        `SELECT ${TX_COLUMNS} FROM transactions WHERE tx_id = $1 FOR UPDATE`,
        [txId],
      );
      const current = result.rows[0];
      if (current === undefined) {
        throw new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);
      }
      if (!options.from.includes(current.status)) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `UPDATE transactions SET status = $2, version = version + 1, updated_at = now()
         WHERE tx_id = $1`,
        [txId, options.to],
      );
      await client.query(
        `INSERT INTO tx_events (tx_id, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [txId, current.status, options.to, JSON.stringify(options.detail)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapTx(row: TxRow, participants: ParticipantRow[]): TxRecord {
  const mappedParticipants: ParticipantRecord[] = participants.map((participant) => ({
    shardId: participant.shard_id,
    gid: participant.gid,
    vote: participant.vote,
    ...(participant.vote_reason === null ? {} : { voteReason: participant.vote_reason }),
    ack: participant.ack,
    attempts: participant.attempts,
    ...(participant.last_error === null ? {} : { lastError: participant.last_error }),
  }));
  return {
    txId: row.tx_id,
    clientRequestId: row.client_request_id,
    from: row.from_account,
    to: row.to_account,
    amount: Number(row.amount),
    status: row.status,
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    participants: mappedParticipants,
  };
}
