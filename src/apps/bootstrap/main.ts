import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { z } from 'zod';
import { parseEnv, nonNegativeIntSchema } from '../../shared/infra/env';
import { createLogger } from '../../shared/infra/logger';
import { ShardMap } from '../../modules/routing/domain/shard-map';
import { accountNumber } from '../../shared/domain/money';

const envSchema = z.object({
  SHARD_A_DATABASE_URL: z.string().min(1),
  SHARD_B_DATABASE_URL: z.string().min(1),
  COORDINATOR_DATABASE_URL: z.string().min(1),
  SHARD_MAP_PATH: z.string().min(1).default('./config/shard-map.yaml'),
  MIGRATIONS_DIR: z.string().min(1).default('./migrations'),
  SEED_BALANCE: nonNegativeIntSchema.default(1000),
});

const MIGRATION_LOCK_KEY = 728_391_045;

async function runMigrations(pool: Pool, directory: string, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const applied = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (row) => row.version,
      ),
    );
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = await readFile(path.join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        process.stdout.write(`[bootstrap] ${label}: applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function seedShard(
  pool: Pool,
  shardId: string,
  ranges: readonly { from: string; to: string }[],
  balance: number,
): Promise<void> {
  for (const range of ranges) {
    await pool.query(
      `INSERT INTO accounts (account_id, balance)
       SELECT 'A' || lpad(n::text, 4, '0'), $3
       FROM generate_series($1::int, $2::int) AS n
       ON CONFLICT (account_id) DO NOTHING`,
      [accountNumber(range.from), accountNumber(range.to), balance],
    );
  }
  const result = await pool.query<{ count: string; total: string }>(
    `SELECT count(*)::text AS count, coalesce(sum(balance), 0)::text AS total FROM accounts`,
  );
  process.stdout.write(
    `[bootstrap] shard ${shardId}: ${result.rows[0]?.count ?? '0'} accounts, ` +
      `total ${result.rows[0]?.total ?? '0'}\n`,
  );
}

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  const logger = createLogger({ service: 'bootstrap' });
  const shardMap = ShardMap.load(env.SHARD_MAP_PATH);
  logger.info(
    { version: shardMap.version, fingerprint: shardMap.fingerprint(), ranges: shardMap.describeRanges() },
    'shard map loaded',
  );

  const shardPoolA = new Pool({ connectionString: env.SHARD_A_DATABASE_URL, max: 4 });
  const shardPoolB = new Pool({ connectionString: env.SHARD_B_DATABASE_URL, max: 4 });
  const coordinatorPool = new Pool({ connectionString: env.COORDINATOR_DATABASE_URL, max: 2 });

  try {
    await runMigrations(shardPoolA, path.join(env.MIGRATIONS_DIR, 'shard'), 'shard A');
    await runMigrations(shardPoolB, path.join(env.MIGRATIONS_DIR, 'shard'), 'shard B');
    await runMigrations(
      coordinatorPool,
      path.join(env.MIGRATIONS_DIR, 'coordinator'),
      'coordinator',
    );

    for (const shard of shardMap.allShards()) {
      if (shard.id === 'A') {
        await seedShard(shardPoolA, 'A', shard.ranges, env.SEED_BALANCE);
      } else if (shard.id === 'B') {
        await seedShard(shardPoolB, 'B', shard.ranges, env.SEED_BALANCE);
      } else {
        throw new Error(`Bootstrap does not know a database URL for shard ${shard.id}`);
      }
    }
    logger.info('bootstrap completed');
  } finally {
    await Promise.all([shardPoolA.end(), shardPoolB.end(), coordinatorPool.end()]);
  }
}

main().catch((error) => {
  process.stderr.write(`[bootstrap] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
