import type { FaultInjector } from '../application/ports';

/**
 * Demo/test-only fault hooks. They are selected by the FAULTS environment
 * variable and never run inside the recovery path.
 */
export class ScriptedFaultInjector implements FaultInjector {
  constructor(
    private readonly faults: ReadonlySet<string>,
    private readonly log: (message: string, fields: object) => void,
  ) {}

  async afterPrepare(txId: string): Promise<void> {
    if (this.faults.has('crash_after_prepare')) {
      this.log('fault: crashing after all participants prepared', { txId });
      this.crash();
    }
  }

  async afterDecision(txId: string, decision: 'COMMIT_DECIDED' | 'ABORT_DECIDED'): Promise<void> {
    if (this.faults.has('crash_after_decision')) {
      this.log('fault: crashing after durable decision', { txId, decision });
      this.crash();
    }
  }

  /**
   * A container's PID 1 cannot be killed with SIGKILL from inside its own PID
   * namespace, so simulate an abrupt crash with a non-zero exit instead.
   */
  private crash(): never {
    process.exit(137);
  }
}

export function createFaultInjector(
  raw: string | undefined,
  log: (message: string, fields: object) => void,
): FaultInjector | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return new ScriptedFaultInjector(new Set(raw.split(',').map((item) => item.trim())), log);
}
