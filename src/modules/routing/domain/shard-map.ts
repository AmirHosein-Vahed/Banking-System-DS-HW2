import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { assertAccountId, accountNumber, formatAccountNumber } from '../../../shared/domain/money';
import { accountNotFound, wrongShard } from '../../../shared/domain/errors';

export interface ReplicaEndpoint {
  readonly id: string;
  readonly url: string;
}

export interface ShardDefinition {
  readonly id: string;
  readonly ranges: readonly { readonly from: string; readonly to: string }[];
  readonly replicas: readonly ReplicaEndpoint[];
}

interface NumericRange {
  readonly from: string;
  readonly to: string;
  readonly fromNumber: number;
  readonly toNumber: number;
  readonly shardId: string;
}

const AccountIdSchema = z.string().regex(/^A[0-9]{4}$/, 'expected A followed by four digits');
const ReplicaSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
});
const RangeSchema = z
  .object({
    from: AccountIdSchema,
    to: AccountIdSchema,
  })
  .refine((range) => accountNumber(range.from) <= accountNumber(range.to), {
    message: 'range.from must not be greater than range.to',
  });
const ShardSchema = z.object({
  ranges: z.array(RangeSchema).min(1),
  replicas: z.array(ReplicaSchema).min(1),
});
const ShardMapFileSchema = z.object({
  version: z.number().int().positive(),
  shards: z.record(z.string().regex(/^[A-Z]$/), ShardSchema),
});

export class ShardMap {
  readonly version: number;
  private readonly shards: readonly ShardDefinition[];
  private readonly shardsById: ReadonlyMap<string, ShardDefinition>;
  private readonly ranges: readonly NumericRange[];

  constructor(version: number, shards: readonly ShardDefinition[]) {
    this.version = version;
    this.shards = shards;
    this.shardsById = new Map(shards.map((shard) => [shard.id, shard]));

    const ranges: NumericRange[] = [];
    const replicaIds = new Set<string>();
    for (const shard of shards) {
      for (const replica of shard.replicas) {
        if (replicaIds.has(replica.id)) {
          throw new Error(`Duplicate replica id ${replica.id}`);
        }
        replicaIds.add(replica.id);
      }
      for (const range of shard.ranges) {
        ranges.push({
          from: range.from,
          to: range.to,
          fromNumber: accountNumber(range.from),
          toNumber: accountNumber(range.to),
          shardId: shard.id,
        });
      }
    }

    ranges.sort((a, b) => a.fromNumber - b.fromNumber);
    if (ranges.length === 0) {
      throw new Error('Shard map has no ranges');
    }
    for (let index = 0; index < ranges.length; index += 1) {
      const current = ranges[index]!;
      if (index === 0) {
        if (current.fromNumber !== 1) {
          throw new Error(`Shard map must start at A0001, got ${current.from}`);
        }
      } else {
        const previous = ranges[index - 1]!;
        if (current.fromNumber !== previous.toNumber + 1) {
          throw new Error(
            `Shard map ranges must be contiguous: ${previous.to} is followed by ${current.from}`,
          );
        }
      }
    }
    const last = ranges[ranges.length - 1]!;
    if (last.toNumber !== 2000) {
      throw new Error(`Shard map must end at A2000, got ${last.to}`);
    }
    this.ranges = ranges;
  }

  static load(path: string): ShardMap {
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    const parsed = ShardMapFileSchema.parse(raw);
    const shards: ShardDefinition[] = Object.entries(parsed.shards).map(([id, shard]) => ({
      id,
      ranges: shard.ranges,
      replicas: shard.replicas,
    }));
    return new ShardMap(parsed.version, shards);
  }

  resolve(accountId: string): ShardDefinition {
    assertAccountId(accountId);
    const number = accountNumber(accountId);
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const range = this.ranges[middle]!;
      if (number < range.fromNumber) {
        high = middle - 1;
      } else if (number > range.toNumber) {
        low = middle + 1;
      } else {
        return this.shard(range.shardId);
      }
    }
    throw accountNotFound(accountId);
  }

  shard(shardId: string): ShardDefinition {
    const shard = this.shardsById.get(shardId);
    if (shard === undefined) {
      throw new Error(`Unknown shard ${shardId}`);
    }
    return shard;
  }

  allShards(): readonly ShardDefinition[] {
    return this.shards;
  }

  assertOwns(shardId: string, accountId: string): void {
    const owner = this.resolve(accountId);
    if (owner.id !== shardId) {
      throw wrongShard(accountId, shardId);
    }
  }

  fingerprint(): string {
    const canonical = JSON.stringify({
      version: this.version,
      shards: this.shards
        .map((shard) => ({
          id: shard.id,
          ranges: shard.ranges,
          replicas: shard.replicas,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /** Useful for logs and the report. */
  describeRanges(): string[] {
    return this.ranges.map(
      (range) => `${formatAccountNumber(range.fromNumber)}-${formatAccountNumber(range.toNumber)} -> ${range.shardId}`,
    );
  }
}
