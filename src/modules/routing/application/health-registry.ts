import type { Logger } from 'pino';
import type { ReplicaEndpoint, ShardMap } from '../domain/shard-map';

export interface HealthRegistryOptions {
  readonly shardMap: ShardMap;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly failureThreshold: number;
  readonly logger: Logger;
}

interface ReplicaState {
  readonly endpoint: ReplicaEndpoint;
  readonly shardId: string;
  healthy: boolean;
  failures: number;
}

/**
 * Active health tracking for replicas. Only replicas inside the owning shard
 * are ever considered; requests are never sent to another shard as a fallback.
 */
export class HealthRegistry {
  private readonly states = new Map<string, ReplicaState>();
  private readonly cursors = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HealthRegistryOptions) {
    for (const shard of options.shardMap.allShards()) {
      for (const replica of shard.replicas) {
        this.states.set(replica.url, {
          endpoint: replica,
          shardId: shard.id,
          healthy: false,
          failures: 0,
        });
      }
    }
  }

  async start(): Promise<void> {
    await this.probeAll();
    this.timer = setInterval(() => {
      void this.probeAll();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async probeAll(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => this.probe(state)));
  }

  /** Healthy replicas of a shard, starting at the next round-robin position. */
  replicasInOrder(shardId: string): ReplicaEndpoint[] {
    const healthy = [...this.states.values()]
      .filter((state) => state.shardId === shardId && state.healthy)
      .map((state) => state.endpoint);
    if (healthy.length === 0) {
      return [];
    }
    const cursor = this.cursors.get(shardId) ?? 0;
    const ordered = healthy.map((_, index) => healthy[(cursor + index) % healthy.length]!);
    this.cursors.set(shardId, (cursor + 1) % healthy.length);
    return ordered;
  }

  isHealthy(url: string): boolean {
    return this.states.get(url)?.healthy ?? false;
  }

  snapshot(): { shardId: string; replicaId: string; healthy: boolean; failures: number }[] {
    return [...this.states.values()].map((state) => ({
      shardId: state.shardId,
      replicaId: state.endpoint.id,
      healthy: state.healthy,
      failures: state.failures,
    }));
  }

  private async probe(state: ReplicaState): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let ok = false;
    try {
      const response = await fetch(`${state.endpoint.url}/healthz`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      ok = response.ok;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }

    if (ok) {
      const wasHealthy = state.healthy;
      state.healthy = true;
      state.failures = 0;
      if (!wasHealthy) {
        this.options.logger.info(
          { event: 'replica.healthy', shard: state.shardId, replica: state.endpoint.id },
          'replica is healthy',
        );
      }
      return;
    }

    state.failures += 1;
    if (state.healthy && state.failures >= this.options.failureThreshold) {
      state.healthy = false;
      this.options.logger.warn(
        {
          event: 'replica.unhealthy',
          shard: state.shardId,
          replica: state.endpoint.id,
          failures: state.failures,
        },
        'replica marked unhealthy',
      );
    }
  }
}
