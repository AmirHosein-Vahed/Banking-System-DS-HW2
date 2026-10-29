import Fastify from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { parseEnv, portSchema, positiveIntSchema } from '../../shared/infra/env';
import { createLogger } from '../../shared/infra/logger';
import { ShardMap } from '../../modules/routing/domain/shard-map';
import { PgAccountStore } from '../../modules/accounts/adapters/pg-account-store';
import { registerAccountRoutes } from '../../modules/accounts/adapters/http-routes';
import { ParticipantService } from '../../modules/participation/application/participant-service';
import { registerParticipantRoutes } from '../../modules/participation/adapters/http-routes';
import {
  attachRequestLogging,
  registerErrorHandler,
} from '../../shared/infra/http';
import {
  attachConcurrencyLimit,
  attachReplicaHeader,
} from '../../shared/infra/concurrency';

const envSchema = z.object({
  PORT: portSchema.default(8080),
  SHARD_ID: z.string().regex(/^[A-Z]$/),
  REPLICA_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SHARD_MAP_PATH: z.string().min(1).default('./config/shard-map.yaml'),
  INTERNAL_TOKEN: z.string().min(1),
  MAX_CONCURRENT_REQUESTS: positiveIntSchema.default(100),
  DB_POOL_SIZE: positiveIntSchema.default(10),
  LOG_LEVEL: z.string().default('info'),
});

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  const logger = createLogger({
    service: 'shard',
    shard: env.SHARD_ID,
    replica: env.REPLICA_ID,
    level: env.LOG_LEVEL,
  });
  const shardMap = ShardMap.load(env.SHARD_MAP_PATH);
  logger.info(
    { version: shardMap.version, fingerprint: shardMap.fingerprint(), ranges: shardMap.describeRanges() },
    'shard map loaded',
  );

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_SIZE,
    statement_timeout: 10_000,
  });
  pool.on('error', (error) => logger.error({ err: error }, 'idle database client error'));

  const store = new PgAccountStore(pool, env.SHARD_ID, shardMap);
  const participants = new ParticipantService({
    pool,
    shardId: env.SHARD_ID,
    shardMap,
    // Leave at least two connections for COMMIT/ROLLBACK PREPARED resolution.
    maxConcurrentPrepares: Math.max(2, env.DB_POOL_SIZE - 3),
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 20_000,
    connectionTimeout: 10_000,
  });

  attachRequestLogging(app, logger);
  attachConcurrencyLimit(app, env.MAX_CONCURRENT_REQUESTS);
  attachReplicaHeader(app, env.REPLICA_ID);
  registerErrorHandler(app, logger);

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'shard',
    shard: env.SHARD_ID,
    replica: env.REPLICA_ID,
  }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return {
        status: 'ok',
        service: 'shard',
        shard: env.SHARD_ID,
        replica: env.REPLICA_ID,
        database: 'ok',
      };
    } catch (error) {
      logger.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({
        status: 'error',
        service: 'shard',
        shard: env.SHARD_ID,
        replica: env.REPLICA_ID,
        database: 'unavailable',
      });
    }
  });

  registerAccountRoutes(app, { store, internalToken: env.INTERNAL_TOKEN });
  registerParticipantRoutes(app, { service: participants, internalToken: env.INTERNAL_TOKEN });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT }, 'shard replica listening');
}

main().catch((error) => {
  process.stderr.write(
    `[shard] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
