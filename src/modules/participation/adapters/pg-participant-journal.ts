import type { Pool, PoolClient } from 'pg';
import type { ParticipantOp, ParticipantRecord, ParticipantState } from '../domain/participant';

/**
 * Durable participant journal. Rows are written outside the prepared
 * transaction so that abort fencing and idempotent retries are possible.
 */
export class PgParticipantJournal {
  constructor(private readonly pool: Pool) {}

  /**
   * Serialises all protocol operations for one transaction on this database.
   * The lock is session-scoped, so a crashed session releases it automatically
   * while a prepared transaction survives.
   */
  async withLock<T>(txId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [txId]);
      return await work(client);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [txId])
        .catch(() => undefined);
      client.release();
    }
  }

  async get(client: PoolClient, txId: string): Promise<ParticipantRecord | undefined> {
    const result = await client.query<{
      tx_id: string;
      gid: string;
      shard_id: string;
      ops: ParticipantOp[];
      state: ParticipantState;
    }>('SELECT tx_id, gid, shard_id, ops, state FROM participant_txs WHERE tx_id = $1', [txId]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      txId: row.tx_id,
      gid: row.gid,
      shardId: row.shard_id,
      ops: row.ops,
      state: row.state,
    };
  }

  async upsertPreparing(
    client: PoolClient,
    record: {
      txId: string;
      gid: string;
      shardId: string;
      ops: readonly ParticipantOp[];
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO participant_txs (tx_id, gid, shard_id, ops, state)
       VALUES ($1, $2, $3, $4::jsonb, 'PREPARING')
       ON CONFLICT (tx_id) DO UPDATE
       SET gid = EXCLUDED.gid, shard_id = EXCLUDED.shard_id,
           ops = EXCLUDED.ops, state = 'PREPARING', updated_at = now()
       WHERE participant_txs.state = 'PREPARING'`,
      [record.txId, record.gid, record.shardId, JSON.stringify(record.ops)],
    );
  }

  async setState(client: PoolClient, txId: string, state: ParticipantState): Promise<void> {
    await client.query(
      `UPDATE participant_txs SET state = $2, updated_at = now() WHERE tx_id = $1`,
      [txId, state],
    );
  }

  /**
   * Abort may arrive before the prepare RPC. Writing a tombstone ensures a late
   * prepare can never create a prepared transaction after the abort decision.
   */
  async upsertAborted(
    client: PoolClient,
    record: { txId: string; gid: string; shardId: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO participant_txs (tx_id, gid, shard_id, ops, state)
       VALUES ($1, $2, $3, '[]'::jsonb, 'ABORTED')
       ON CONFLICT (tx_id) DO UPDATE
       SET state = 'ABORTED', updated_at = now()
       WHERE participant_txs.state <> 'COMMITTED'`,
      [record.txId, record.gid, record.shardId],
    );
  }
}
