import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";
import {
  getAbortError,
  throwIfAborted,
} from "../cancellation/index.js";
import { FifoQueue } from "./fifo-queue.js";
import type { ConcurrentOperation, WaitOptions } from "./types.js";

export interface SemaphorePermit {
  /** 幂等释放许可；重复调用不会增加可用配额。 */
  release(): void;
}

interface PermitWaiter {
  readonly reject: (reason: unknown) => void;
  removeAbortListener: () => void;
  readonly resolve: (permit: SemaphorePermit) => void;
  readonly signal: AbortSignal | undefined;
}

/** FIFO 信号量，用于限制共享外部资源的并发数量。 */
export class Semaphore {
  private active = 0;
  private readonly waiters = new FifoQueue<PermitWaiter>();

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new BumblebeeError("Semaphore limit must be a positive integer", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { limit },
      });
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get availableCount(): number {
    return this.limit - this.active;
  }

  get pendingCount(): number {
    return this.waiters.size;
  }

  acquire(options: WaitOptions = {}): Promise<SemaphorePermit> {
    if (options.signal?.aborted) {
      return Promise.reject(getAbortError(options.signal));
    }

    if (this.active < this.limit && this.waiters.size === 0) {
      this.active += 1;
      return Promise.resolve(this.createPermit());
    }

    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: PermitWaiter = {
        reject,
        removeAbortListener: () => {},
        resolve,
        signal: options.signal,
      };
      const node = this.waiters.enqueue(waiter);

      if (options.signal !== undefined) {
        const onAbort = () => {
          if (!this.waiters.remove(node)) {
            return;
          }

          waiter.removeAbortListener();
          reject(getAbortError(options.signal as AbortSignal));
        };

        options.signal.addEventListener("abort", onAbort, { once: true });
        waiter.removeAbortListener = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };

        // 覆盖初次检查与监听器注册之间发生取消的竞态窗口。
        if (options.signal.aborted) {
          onAbort();
        }
      }
    });
  }

  async runExclusive<T>(
    operation: ConcurrentOperation<T>,
    options: WaitOptions = {},
  ): Promise<T> {
    const permit = await this.acquire(options);

    try {
      // 许可发放后、调用方恢复执行前仍可能收到取消。
      throwIfAborted(options.signal);
      return await operation(options.signal);
    } finally {
      permit.release();
    }
  }

  private createPermit(): SemaphorePermit {
    let released = false;

    return Object.freeze({
      release: () => {
        if (released) {
          return;
        }

        released = true;
        this.releasePermit();
      },
    });
  }

  private releasePermit(): void {
    this.active -= 1;

    const waiter = this.waiters.dequeue();
    if (waiter === undefined) {
      return;
    }

    waiter.removeAbortListener();
    this.active += 1;
    waiter.resolve(this.createPermit());
  }
}
