import type { Pool, PoolClient } from 'pg';
import type { AccountStore } from '../application/ports';
import type {
  AccountBalance,
  DepositCommand,
  LocalTransferCommand,
  LocalTransferResult,
  WithdrawCommand,
} from '../domain/account';
import { accountNotFound, idempotencyConflict, insufficientFunds, validationError } from '../../../shared/domain/errors';
import type { ShardMap } from '../../routing/domain/shard-map';

interface StoredResponse {
  payload_hash: string;
  response: unknown;
}

export class PgAccountStore implements AccountStore {
  constructor(
    private readonly pool: Pool,
    private readonly shardId: string,
    private readonly shardMap: ShardMap,
  ) {}

  async getBalance(accountId: string): Promise<AccountBalance> {
    this.shardMap.assertOwns(this.shardId, accountId);
    const result = await this.pool.query<{ balance: string }>(
      'SELECT balance FROM accounts WHERE account_id = $1',
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw accountNotFound(accountId);
    }
    return { accountId, balance: Number(row.balance) };
  }

  async deposit(command: DepositCommand): Promise<AccountBalance> {
    return this.writeOperation(command, async (client) => {
      const result = await client.query<{ balance: string }>(
        `UPDATE accounts
         SET balance = balance + $2, version = version + 1, updated_at = now()
         WHERE account_id = $1
         RETURNING balance`,
        [command.accountId, command.amount],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw accountNotFound(command.accountId);
      }
      await client.query(
        `INSERT INTO ledger_entries (tx_id, account_id, delta, reason)
         VALUES ($1, $2, $3, 'deposit')`,
        [command.requestId, command.accountId, command.amount],
      );
      return { accountId: command.accountId, balance: Number(row.balance) };
    });
  }

  async withdraw(command: WithdrawCommand): Promise<AccountBalance> {
    return this.writeOperation(command, async (client) => {
      const result = await client.query<{ balance: string }>(
        `UPDATE accounts
         SET balance = balance - $2, version = version + 1, updated_at = now()
         WHERE account_id = $1 AND balance >= $2
         RETURNING balance`,
        [command.accountId, command.amount],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await this.assertAccountExists(client, command.accountId);
        throw insufficientFunds(command.accountId);
      }
      await client.query(
        `INSERT INTO ledger_entries (tx_id, account_id, delta, reason)
         VALUES ($1, $2, $3, 'withdraw')`,
        [command.requestId, command.accountId, -command.amount],
      );
      return { accountId: command.accountId, balance: Number(row.balance) };
    });
  }

  async transferLocal(command: LocalTransferCommand): Promise<LocalTransferResult> {
    if (command.from === command.to) {
      throw validationError('from and to must be different accounts');
    }
    this.shardMap.assertOwns(this.shardId, command.from);
    this.shardMap.assertOwns(this.shardId, command.to);

    return this.writeOperation(command, async (client) => {
      // Deterministic lock order prevents deadlocks between opposite transfers.
      const locked = await client.query<{ account_id: string; balance: string }>(
        `SELECT account_id, balance
         FROM accounts
         WHERE account_id = ANY($1::text[])
         ORDER BY account_id
         FOR UPDATE`,
        [[command.from, command.to]],
      );
      if (locked.rows.length !== 2) {
        await this.assertAccountExists(client, command.from);
        throw accountNotFound(command.to);
      }
      const fromRow = locked.rows.find((row) => row.account_id === command.from)!;
      const fromBalance = Number(fromRow.balance);
      if (fromBalance < command.amount) {
        throw insufficientFunds(command.from);
      }
      const updatedFrom = await client.query<{ balance: string }>(
        `UPDATE accounts SET balance = balance - $2, version = version + 1, updated_at = now()
         WHERE account_id = $1 RETURNING balance`,
        [command.from, command.amount],
      );
      const updatedTo = await client.query<{ balance: string }>(
        `UPDATE accounts SET balance = balance + $2, version = version + 1, updated_at = now()
         WHERE account_id = $1 RETURNING balance`,
        [command.to, command.amount],
      );
      await client.query(
        `INSERT INTO ledger_entries (tx_id, account_id, delta, reason)
         VALUES ($1, $2, $3, 'transfer'), ($1, $4, $5, 'transfer')`,
        [command.requestId, command.from, -command.amount, command.to, command.amount],
      );
      return {
        from: { accountId: command.from, balance: Number(updatedFrom.rows[0]?.balance ?? 0) },
        to: { accountId: command.to, balance: Number(updatedTo.rows[0]?.balance ?? 0) },
      };
    });
  }

  private async writeOperation<T>(
    command: { readonly requestId: string; readonly payloadHash: string },
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise retries of the same request, then check the idempotency record.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        command.requestId,
      ]);

      const existing = await client.query<StoredResponse>(
        'SELECT payload_hash, response FROM client_requests WHERE request_id = $1',
        [command.requestId],
      );
      const record = existing.rows[0];
      if (record !== undefined) {
        if (record.payload_hash !== command.payloadHash) {
          throw idempotencyConflict(command.requestId);
        }
        await client.query('COMMIT');
        return record.response as T;
      }

      const result = await operation(client);
      await client.query(
        `INSERT INTO client_requests (request_id, payload_hash, response)
         VALUES ($1, $2, $3::jsonb)`,
        [command.requestId, command.payloadHash, JSON.stringify(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertAccountExists(client: PoolClient, accountId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM accounts WHERE account_id = $1', [accountId]);
    if (result.rowCount === 0) {
      throw accountNotFound(accountId);
    }
  }
}
