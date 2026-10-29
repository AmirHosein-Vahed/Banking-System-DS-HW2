import type { Pool, PoolClient } from 'pg';
import { assertGid } from '../../../shared/domain/ids';

/**
 * All PostgreSQL prepared-transaction SQL lives here. The GID must be a string
 * literal; it is validated and quoted in exactly one place.
 *
 * An optional client can be supplied when the caller already holds a session
 * advisory lock and a pooled connection, avoiding a second pool slot.
 */
export class PgPreparedXact {
  constructor(private readonly pool: Pool) {}

  async exists(gid: string, client?: PoolClient): Promise<boolean> {
    const runner = client ?? this.pool;
    const result = await runner.query('SELECT 1 FROM pg_prepared_xacts WHERE gid = $1', [gid]);
    return (result.rowCount ?? 0) > 0;
  }

  async commit(gid: string, client?: PoolClient): Promise<void> {
    assertGid(gid);
    const runner = client ?? this.pool;
    await runner.query(`COMMIT PREPARED '${gid}'`);
  }

  async rollback(gid: string, client?: PoolClient): Promise<void> {
    assertGid(gid);
    const runner = client ?? this.pool;
    await runner.query(`ROLLBACK PREPARED '${gid}'`);
  }
}
