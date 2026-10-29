/**
 * Minimal counting semaphore. The participant service uses it to reserve a
 * few database connections for protocol resolution: if every connection were
 * allowed to block inside a prepare, no connection would be left to run
 * `COMMIT PREPARED` / `ROLLBACK PREPARED` and the pool would stall.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Semaphore limit must be a positive integer');
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
