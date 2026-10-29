import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { HealthRegistry } from '../../src/modules/routing/application/health-registry';
import { ShardMap, type ShardDefinition } from '../../src/modules/routing/domain/shard-map';

const shards: ShardDefinition[] = [
  {
    id: 'A',
    ranges: [{ from: 'A0001', to: 'A1000' }],
    replicas: [
      { id: 'a1', url: 'http://a1:8080' },
      { id: 'a2', url: 'http://a2:8080' },
    ],
  },
  {
    id: 'B',
    ranges: [{ from: 'A1001', to: 'A2000' }],
    replicas: [
      { id: 'b1', url: 'http://b1:8080' },
      { id: 'b2', url: 'http://b2:8080' },
    ],
  },
];

const shardMap = new ShardMap(1, shards);
const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;

function registry(): HealthRegistry {
  return new HealthRegistry({
    shardMap,
    intervalMs: 60_000,
    timeoutMs: 200,
    failureThreshold: 2,
    logger,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNetwork(down: ReadonlySet<string>): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const base = new URL(url);
    const target = `${base.protocol}//${base.host}`;
    if (down.has(target)) {
      throw new Error('ECONNREFUSED');
    }
    return { ok: true } as Response;
  });
}

describe('HealthRegistry', () => {
  it('marks every replica unhealthy before the first probe', () => {
    stubNetwork(new Set());
    const health = registry();
    expect(health.snapshot().every((replica) => !replica.healthy)).toBe(true);
    expect(health.replicasInOrder('A')).toEqual([]);
  });

  it('only returns replicas of the requested shard', async () => {
    stubNetwork(new Set());
    const health = registry();
    await health.start();
    health.stop();

    const replicas = health.replicasInOrder('A');
    expect(replicas.map((replica) => replica.id)).toEqual(['a1', 'a2']);
    expect(replicas.every((replica) => replica.url.includes('a'))).toBe(true);
  });

  it('round-robins the starting replica', async () => {
    stubNetwork(new Set());
    const health = registry();
    await health.start();
    health.stop();

    const first = health.replicasInOrder('A')[0]?.id;
    const second = health.replicasInOrder('A')[0]?.id;
    expect(first).not.toBe(second);
  });

  it('removes a replica after consecutive failures and restores it later', async () => {
    const down = new Set<string>(['http://a1:8080']);
    stubNetwork(down);
    const health = registry();
    await health.start();
    health.stop();

    expect(health.isHealthy('http://a1:8080')).toBe(false);
    expect(health.isHealthy('http://a2:8080')).toBe(true);
    expect(health.replicasInOrder('A').map((replica) => replica.id)).toEqual(['a2']);

    down.delete('http://a1:8080');
    await health.probeAll();
    expect(health.isHealthy('http://a1:8080')).toBe(true);
  });

  it('keeps probing a shard that has lost both replicas', async () => {
    stubNetwork(new Set(['http://a1:8080', 'http://a2:8080']));
    const health = registry();
    await health.start();
    health.stop();

    expect(health.replicasInOrder('A')).toEqual([]);
    expect(health.replicasInOrder('B')).toHaveLength(2);
  });
});
