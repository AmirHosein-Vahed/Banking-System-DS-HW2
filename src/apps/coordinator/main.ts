import Fastify from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { parseEnv, portSchema, positiveIntSchema } from '../../shared/infra/env';
import { createLogger } from '../../shared/infra/logger';
import { ShardMap } from '../../modules/routing/domain/shard-map';
import { PgTxJournal } from '../../modules/coordination/adapters/pg-tx-journal';
import { HttpParticipantClient } from '../../modules/coordination/adapters/participant-client';
import { CoordinatorService } from '../../modules/coordination/application/coordinator-service';
import { registerCoordinatorRoutes } from '../../modules/coordination/adapters/http-routes';
import { createFaultInjector } from '../../modules/coordination/adapters/faults';
import { attachRequestLogging, registerErrorHandler } from '../../shared/infra/http';
import { attachConcurrencyLimit } from '../../shared/infra/concurrency';

const envSchema = z.object({
  PORT: portSchema.default(8081),
  DATABASE_URL: z.string().min(1),
  SHARD_MAP_PATH: z.string().min(1).default('./config/shard-map.yaml'),
  INTERNAL_TOKEN: z.string().min(1),
  PREPARE_TIMEOUT_MS: positiveIntSchema.default(5000),
  RESOLVER_INTERVAL_MS: positiveIntSchema.default(5000),
  DB_POOL_SIZE: positiveIntSchema.default(10),
  MAX_CONCURRENT_REQUESTS: positiveIntSchema.default(200),
  LOG_LEVEL: z.string().default('info'),
  FAULTS: z.string().optional(),
});

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  const logger = createLogger({ service: 'coordinator', level: env.LOG_LEVEL });
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

  const journal = new PgTxJournal(pool);
  const transport = new HttpParticipantClient({
    shardMap,
    internalToken: env.INTERNAL_TOKEN,
    timeoutMs: env.PREPARE_TIMEOUT_MS,
    logger,
  });
  const faults = createFaultInjector(env.FAULTS, (message, fields) =>
    logger.warn({ event: 'fault', ...fields }, message),
  );
  const service = new CoordinatorService(journal, transport, shardMap, faults, logger);

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
  });
  attachRequestLogging(app, logger);
  attachConcurrencyLimit(app, env.MAX_CONCURRENT_REQUESTS);
  registerErrorHandler(app, logger);

  let initialSweepDone = false;
  app.get('/healthz', async () => ({ status: 'ok', service: 'coordinator' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      if (!initialSweepDone) {
        return reply
          .status(503)
          .send({ status: 'starting', service: 'coordinator', recovery: 'in_progress' });
      }
      return { status: 'ok', service: 'coordinator', recovery: 'complete' };
    } catch (error) {
      logger.error({ err: error }, 'coordinator readiness check failed');
      return reply.status(503).send({ status: 'error', service: 'coordinator' });
    }
  });

  registerCoordinatorRoutes(app, {
    service,
    journal,
    internalToken: env.INTERNAL_TOKEN,
  });

  const runRecovery = async (reason: string): Promise<void> => {
    try {
      const count = await service.resolveOnce();
      if (count > 0) {
        logger.info({ event: 'recovery.sweep', count, reason }, 'recovery sweep processed transactions');
      }
    } catch (error) {
      logger.error({ event: 'recovery.sweep_failed', reason, err: error }, 'recovery sweep failed');
    }
  };

  await runRecovery('startup');
  initialSweepDone = true;
  const resolver = setInterval(() => {
    void runRecovery('interval');
  }, env.RESOLVER_INTERVAL_MS);
  resolver.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    clearInterval(resolver);
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, faults: env.FAULTS ?? '' }, 'coordinator listening');
}

main().catch((error) => {
  process.stderr.write(
    `[coordinator] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
