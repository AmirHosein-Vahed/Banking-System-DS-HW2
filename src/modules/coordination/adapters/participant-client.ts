import type { Logger } from 'pino';
import type { ShardMap } from '../../routing/domain/shard-map';
import type { ParticipantOp } from '../../participation/domain/participant';
import type { ParticipantTransport, PrepareVoteResult } from '../application/ports';
import { fetchJson } from '../../../shared/infra/internal-client';
import { AppError } from '../../../shared/domain/errors';

export interface HttpParticipantClientOptions {
  readonly shardMap: ShardMap;
  readonly internalToken: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

interface PrepareResponse {
  readonly vote: 'YES' | 'NO';
  readonly code?: string;
  readonly message?: string;
}

/**
 * Participant calls may be served by any replica of the shard because prepared
 * transactions live in the shared database. On a transport failure we try the
 * next replica; a protocol-level NO vote is returned immediately.
 */
export class HttpParticipantClient implements ParticipantTransport {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly options: HttpParticipantClientOptions) {}

  async prepare(
    shardId: string,
    txId: string,
    gid: string,
    ops: readonly ParticipantOp[],
  ): Promise<PrepareVoteResult> {
    const response = await this.call<PrepareResponse>(shardId, '/internal/v1/participants/prepare', {
      txId,
      gid,
      shardId,
      ops,
    });
    if (response.vote === 'NO') {
      return {
        vote: 'NO',
        code: response.code ?? 'PARTICIPANT_REJECTED',
        message: response.message ?? 'Participant rejected the transaction',
      };
    }
    return { vote: 'YES' };
  }

  async commit(shardId: string, txId: string, gid: string): Promise<void> {
    await this.call(shardId, '/internal/v1/participants/commit', { txId, gid });
  }

  async abort(shardId: string, txId: string, gid: string): Promise<void> {
    await this.call(shardId, '/internal/v1/participants/abort', { txId, gid });
  }

  private async call<T>(shardId: string, path: string, body: unknown): Promise<T> {
    const shard = this.options.shardMap.shard(shardId);
    const start = this.cursors.get(shardId) ?? 0;
    let lastError: unknown;
    for (let offset = 0; offset < shard.replicas.length; offset += 1) {
      const index = (start + offset) % shard.replicas.length;
      const replica = shard.replicas[index]!;
      try {
        const response = await fetchJson<T>(`${replica.url}${path}`, {
          method: 'POST',
          body,
          timeoutMs: this.options.timeoutMs,
          internalToken: this.options.internalToken,
        });
        this.cursors.set(shardId, (index + 1) % shard.replicas.length);
        return response.body;
      } catch (error) {
        lastError = error;
        this.options.logger.warn(
          { shard: shardId, replica: replica.id, path, err: error },
          'participant call failed, trying next replica',
        );
      }
    }
    throw new AppError(
      'INTERNAL_ERROR',
      `All replicas of shard ${shardId} failed for ${path}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      502,
    );
  }
}
