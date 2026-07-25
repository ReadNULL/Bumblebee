import type { LifecycleCleanup } from "./types.js";

interface CleanupEntry {
  readonly cleanup: LifecycleCleanup;
  readonly name: string;
}

export interface CleanupFailure {
  readonly error: unknown;
  readonly name: string;
}

/** 顺序获取的资源必须逆序释放，避免先销毁仍被依赖的底层资源。 */
export class CleanupStack {
  private readonly entries: CleanupEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(name: string, cleanup: LifecycleCleanup): void {
    this.entries.push({ cleanup, name });
  }

  async disposeAll(): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = [];

    while (this.entries.length > 0) {
      const entry = this.entries.pop();
      if (entry === undefined) {
        break;
      }

      try {
        await entry.cleanup();
      } catch (error: unknown) {
        failures.push({ error, name: entry.name });
      }
    }

    return failures;
  }
}
