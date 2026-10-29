import type { Logger } from 'pino';
import type { FastifyRequest } from 'fastify';
import type { HealthRegistry } from '../application/health-registry';
import { fetchJson } from '../../../shared/infra/internal-client';
import { isAppError, shardUnavailable } from '../../../shared/domain/errors';

export interface ShardClientOptions {
  readonly health: HealthRegistry;
  readonly internalToken: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export interface ShardResult<T> {
  readonly body: T;
  readonly shardId: string;
  readonly replicaId: string;
}

export class ShardClient {
  constructor(private readonly options: ShardClientOptions) {}

  async call<T>(
    shardId: string,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<ShardResult<T>> {
    const replicas = this.options.health.replicasInOrder(shardId);
    if (replicas.length === 0) {
      throw shardUnavailable(shardId);
    }
    let lastError: unknown;
    for (const replica of replicas) {
      try {
        const response = await fetchJson<T>(`${replica.url}${path}`, {
          method,
          ...(body === undefined ? {} : { body }),
          timeoutMs: this.options.timeoutMs,
          internalToken: this.options.internalToken,
          requestId: request.requestId,
          clientIp: request.ip,
        });
        return { body: response.body, shardId, replicaId: replica.id };
      } catch (error) {
        lastError = error;
        if (isAppError(error) && error.httpStatus < 500) {
          // Application-level errors (insufficient funds, validation, ...) are
          // deterministic; retrying another replica cannot change the answer.
          throw error;
        }
        this.options.logger.warn(
          { event: 'shard.retry', shard: shardId, replica: replica.id, path, err: error },
          'replica call failed, trying next healthy replica',
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : shardUnavailable(shardId);
  }
}
