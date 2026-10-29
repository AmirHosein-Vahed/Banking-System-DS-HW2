import Fastify from 'fastify';
import { z } from 'zod';
import { parseEnv, portSchema, positiveIntSchema } from '../../shared/infra/env';
import { createLogger } from '../../shared/infra/logger';
import { ShardMap } from '../../modules/routing/domain/shard-map';
import { HealthRegistry } from '../../modules/routing/application/health-registry';
import { ShardClient } from '../../modules/routing/adapters/shard-client';
import { CoordinatorClient } from '../../modules/coordination/adapters/coordinator-client';
import { registerGatewayRoutes } from './routes';
import { attachRequestLogging, registerErrorHandler } from '../../shared/infra/http';
import { attachConcurrencyLimit } from '../../shared/infra/concurrency';

const envSchema = z.object({
  PORT: portSchema.default(8080),
  SHARD_MAP_PATH: z.string().min(1).default('./config/shard-map.yaml'),
  COORDINATOR_URL: z.string().url(),
  INTERNAL_TOKEN: z.string().min(1),
  MAX_CONCURRENT_REQUESTS: positiveIntSchema.default(200),
  HEALTH_INTERVAL_MS: positiveIntSchema.default(2000),
  HEALTH_TIMEOUT_MS: positiveIntSchema.default(500),
  HEALTH_FAILURE_THRESHOLD: positiveIntSchema.default(3),
  SHARD_REQUEST_TIMEOUT_MS: positiveIntSchema.default(5000),
  COORDINATOR_REQUEST_TIMEOUT_MS: positiveIntSchema.default(20_000),
  LOG_LEVEL: z.string().default('info'),
});

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  const logger = createLogger({ service: 'gateway', level: env.LOG_LEVEL });
  const shardMap = ShardMap.load(env.SHARD_MAP_PATH);
  logger.info(
    { version: shardMap.version, fingerprint: shardMap.fingerprint(), ranges: shardMap.describeRanges() },
    'shard map loaded',
  );

  const health = new HealthRegistry({
    shardMap,
    intervalMs: env.HEALTH_INTERVAL_MS,
    timeoutMs: env.HEALTH_TIMEOUT_MS,
    failureThreshold: env.HEALTH_FAILURE_THRESHOLD,
    logger,
  });
  await health.start();

  const shardClient = new ShardClient({
    health,
    internalToken: env.INTERNAL_TOKEN,
    timeoutMs: env.SHARD_REQUEST_TIMEOUT_MS,
    logger,
  });
  const coordinatorClient = new CoordinatorClient({
    baseUrl: env.COORDINATOR_URL,
    internalToken: env.INTERNAL_TOKEN,
    timeoutMs: env.COORDINATOR_REQUEST_TIMEOUT_MS,
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  });
  attachRequestLogging(app, logger);
  attachConcurrencyLimit(app, env.MAX_CONCURRENT_REQUESTS);
  registerErrorHandler(app, logger);

  app.get('/healthz', async () => ({ status: 'ok', service: 'gateway' }));
  app.get('/readyz', async (_request, reply) => {
    const summary = health.snapshot();
    const shards = [...new Set(summary.map((replica) => replica.shardId))];
    const missing = shards.filter(
      (shardId) => !summary.some((replica) => replica.shardId === shardId && replica.healthy),
    );
    if (missing.length > 0) {
      return reply.status(503).send({
        status: 'degraded',
        service: 'gateway',
        shardsWithoutHealthyReplica: missing,
      });
    }
    return { status: 'ok', service: 'gateway' };
  });

  registerGatewayRoutes(app, { shardMap, shardClient, coordinatorClient, health });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    health.stop();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, replicas: health.snapshot() }, 'gateway listening');
}

main().catch((error) => {
  process.stderr.write(
    `[gateway] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
