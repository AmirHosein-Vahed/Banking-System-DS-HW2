import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/shared/infra/keyed-mutex';
import { Semaphore } from '../../src/shared/infra/semaphore';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('serialises work for the same key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const task = (name: string) => async () => {
      events.push(`${name}:enter`);
      await delay(20);
      events.push(`${name}:leave`);
    };

    await Promise.all([
      mutex.run('k', task('first')),
      mutex.run('k', task('second')),
      mutex.run('k', task('third')),
    ]);

    expect(events).toEqual([
      'first:enter',
      'first:leave',
      'second:enter',
      'second:leave',
      'third:enter',
      'third:leave',
    ]);
  });

  it('runs different keys in parallel', async () => {
    const mutex = new KeyedMutex();
    const started = Date.now();
    await Promise.all([
      mutex.run('a', () => delay(50)),
      mutex.run('b', () => delay(50)),
    ]);
    expect(Date.now() - started).toBeLessThan(95);
  });

  it('releases the key when the critical section throws', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('acquires several keys in sorted order without deadlocking', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const a = mutex.runMany(['A1500', 'A0500'], async () => {
      order.push('forward');
      await delay(10);
    });
    const b = mutex.runMany(['A0500', 'A1500'], async () => {
      order.push('backward');
      await delay(10);
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['forward', 'backward']);
  });
});

describe('Semaphore', () => {
  it('never exceeds the configured concurrency', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(5);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('releases the slot when work rejects', async () => {
    const semaphore = new Semaphore(1);
    await expect(
      semaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });
});
