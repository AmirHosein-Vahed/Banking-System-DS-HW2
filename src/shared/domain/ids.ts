import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function gidFor(txId: string, shardId: string): string {
  return `bank2pc:${txId}:${shardId}`;
}

/**
 * PostgreSQL accepts the transaction identifier as a string literal, not as a
 * bind parameter. We therefore restrict the alphabet and quote it in exactly
 * one adapter.
 */
export const GID_PATTERN = /^[A-Za-z0-9:_-]{1,190}$/;

export function assertGid(gid: string): string {
  if (!GID_PATTERN.test(gid)) {
    throw new Error(`Unsafe transaction identifier: ${gid}`);
  }
  return gid;
}
