import { describe, expect, it } from 'vitest';
import { ShardMap, type ShardDefinition } from '../../src/modules/routing/domain/shard-map';
import { isAppError } from '../../src/shared/domain/errors';

const shards: ShardDefinition[] = [
  {
    id: 'A',
    ranges: [{ from: 'A0001', to: 'A1000' }],
    replicas: [{ id: 'a1', url: 'http://a1:8080' }],
  },
  {
    id: 'B',
    ranges: [{ from: 'A1001', to: 'A2000' }],
    replicas: [{ id: 'b1', url: 'http://b1:8080' }],
  },
];

describe('ShardMap', () => {
  const map = new ShardMap(1, shards);

  it('routes boundary accounts to the correct shard', () => {
    expect(map.resolve('A0001').id).toBe('A');
    expect(map.resolve('A1000').id).toBe('A');
    expect(map.resolve('A1001').id).toBe('B');
    expect(map.resolve('A2000').id).toBe('B');
  });

  it('rejects accounts outside the configured range', () => {
    try {
      map.resolve('A2001');
      expect.unreachable('expected an unknown-account error');
    } catch (error) {
      expect(isAppError(error) && error.code === 'ACCOUNT_NOT_FOUND').toBe(true);
    }
  });

  it('rejects a shard that does not own an account', () => {
    try {
      map.assertOwns('A', 'A1500');
      expect.unreachable('expected a wrong-shard error');
    } catch (error) {
      expect(isAppError(error) && error.code === 'WRONG_SHARD').toBe(true);
    }
    expect(() => map.assertOwns('B', 'A1500')).not.toThrow();
  });

  it('supports several ranges per shard', () => {
    const multi = new ShardMap(2, [
      {
        id: 'A',
        ranges: [
          { from: 'A0001', to: 'A0500' },
          { from: 'A1001', to: 'A2000' },
        ],
        replicas: shards[0]!.replicas,
      },
      {
        id: 'B',
        ranges: [{ from: 'A0501', to: 'A1000' }],
        replicas: shards[1]!.replicas,
      },
    ]);
    expect(multi.resolve('A0500').id).toBe('A');
    expect(multi.resolve('A0501').id).toBe('B');
    expect(multi.resolve('A1500').id).toBe('A');
  });

  it('refuses gaps, overlaps and incomplete coverage', () => {
    expect(
      () =>
        new ShardMap(1, [
          { id: 'A', ranges: [{ from: 'A0001', to: 'A0999' }], replicas: shards[0]!.replicas },
          { id: 'B', ranges: [{ from: 'A1001', to: 'A2000' }], replicas: shards[1]!.replicas },
        ]),
    ).toThrow(/contiguous/);

    expect(
      () =>
        new ShardMap(1, [
          { id: 'A', ranges: [{ from: 'A0001', to: 'A1000' }], replicas: shards[0]!.replicas },
          { id: 'B', ranges: [{ from: 'A1000', to: 'A2000' }], replicas: shards[1]!.replicas },
        ]),
    ).toThrow(/contiguous/);

    expect(
      () =>
        new ShardMap(1, [
          { id: 'A', ranges: [{ from: 'A0001', to: 'A1000' }], replicas: shards[0]!.replicas },
        ]),
    ).toThrow(/A2000/);
  });

  it('rejects duplicate replica ids across the whole map', () => {
    expect(
      () =>
        new ShardMap(1, [
          { id: 'A', ranges: [{ from: 'A0001', to: 'A1000' }], replicas: [{ id: 'x', url: 'http://x' }] },
          { id: 'B', ranges: [{ from: 'A1001', to: 'A2000' }], replicas: [{ id: 'x', url: 'http://y' }] },
        ]),
    ).toThrow(/Duplicate replica/);
  });

  it('produces a stable fingerprint independent of shard order', () => {
    const reversed = new ShardMap(1, [shards[1]!, shards[0]!]);
    expect(reversed.fingerprint()).toBe(map.fingerprint());
  });
});
