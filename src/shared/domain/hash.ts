import { createHash } from 'node:crypto';

/** Stable hash for idempotency payload comparison. */
export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
