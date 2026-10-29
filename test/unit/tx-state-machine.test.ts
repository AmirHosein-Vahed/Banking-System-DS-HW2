import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  toView,
  type TxRecord,
} from '../../src/modules/coordination/domain/tx';

describe('transaction state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('INITIATED', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'PREPARED')).toBe(true);
    expect(canTransition('PREPARING', 'ABORT_DECIDED')).toBe(true);
    expect(canTransition('PREPARED', 'COMMIT_DECIDED')).toBe(true);
    expect(canTransition('COMMIT_DECIDED', 'COMPLETED')).toBe(true);
    expect(canTransition('ABORT_DECIDED', 'COMPLETED')).toBe(true);
  });

  it('never leaves the terminal state', () => {
    expect(ALLOWED_TRANSITIONS.COMPLETED).toEqual([]);
    expect(canTransition('COMPLETED', 'PREPARING')).toBe(false);
  });

  it('forbids skipping the prepare phase or reversing a decision', () => {
    expect(canTransition('INITIATED', 'PREPARED')).toBe(false);
    expect(canTransition('PREPARED', 'ABORT_DECIDED')).toBe(false);
    expect(canTransition('ABORT_DECIDED', 'COMMIT_DECIDED')).toBe(false);
  });
});

describe('toView', () => {
  const record: TxRecord = {
    txId: 'tx-1',
    clientRequestId: 'req-1',
    from: 'A0500',
    to: 'A1500',
    amount: 10,
    status: 'COMMIT_DECIDED',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    participants: [
      { shardId: 'A', gid: 'g-a', vote: 'YES', ack: 'DONE', attempts: 0 },
      { shardId: 'B', gid: 'g-b', vote: 'YES', ack: 'PENDING', attempts: 1 },
    ],
  };

  it('exposes a pending view until every participant acknowledged', () => {
    const view = toView(record);
    expect(view.status).toBe('PENDING');
    expect(view.phase).toBe('COMMIT_DECIDED');
    expect(view.votes).toEqual({ A: 'YES', B: 'YES' });
    expect(view.acks).toEqual({ A: 'DONE', B: 'PENDING' });
  });

  it('exposes the outcome once completed', () => {
    const view = toView({ ...record, status: 'COMPLETED', outcome: 'COMMITTED' });
    expect(view.status).toBe('COMPLETED');
    expect(view.outcome).toBe('COMMITTED');
  });
});
