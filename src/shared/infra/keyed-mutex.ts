/**
 * In-process async mutex keyed by an arbitrary string.
 *
 * The platform runs exactly one coordinator, and both the public request path
 * and the recovery sweep may try to advance the same transaction at the same
 * time. Serialising by transaction id keeps the state machine single-writer
 * inside the process, so log lines, votes and acknowledgements are emitted
 * once. The durable journal remains the source of truth across restarts.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * Acquires several keys in a deterministic order. Sorting is what prevents
   * two opposite transfers (A→B and B→A) from deadlocking each other.
   */
  async runMany<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();

    const step = async (index: number): Promise<T> => {
      const key = ordered[index];
      if (key === undefined) {
        return work();
      }
      return this.run(key, () => step(index + 1));
    };

    return step(0);
  }
}
