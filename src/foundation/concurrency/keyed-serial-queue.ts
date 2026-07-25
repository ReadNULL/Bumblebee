import { AsyncLocalStorage } from "node:async_hooks";

import {
  getAbortError,
  throwIfAborted,
} from "../cancellation/index.js";
import { FifoQueue } from "./fifo-queue.js";
import type { ConcurrentOperation, WaitOptions } from "./types.js";

interface QueuedTask {
  readonly operation: ConcurrentOperation<unknown>;
  readonly reject: (reason: unknown) => void;
  removeAbortListener: () => void;
  readonly resolve: (value: unknown) => void;
  readonly signal: AbortSignal | undefined;
}

interface KeyState {
  readonly pending: FifoQueue<QueuedTask>;
  running: boolean;
}

/** 同一个 key 严格串行、不同 key 可并行的任务队列。 */
export class KeyedSerialQueue<Key> {
  private readonly states = new Map<Key, KeyState>();

  get activeKeyCount(): number {
    return this.states.size;
  }

  get pendingCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      count += state.pending.size;
    }
    return count;
  }

  getPendingCount(key: Key): number {
    return this.states.get(key)?.pending.size ?? 0;
  }

  isRunning(key: Key): boolean {
    return this.states.get(key)?.running ?? false;
  }

  enqueue<T>(
    key: Key,
    operation: ConcurrentOperation<T>,
    options: WaitOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(getAbortError(options.signal));
    }

    const state = this.getOrCreateState(key);

    const result = new Promise<T>((resolve, reject) => {
      const task: QueuedTask = {
        // 后续任务由前一任务唤醒，必须保留 enqueue 调用者的异步上下文。
        operation: AsyncLocalStorage.bind(operation),
        reject,
        removeAbortListener: () => {},
        resolve: (value) => resolve(value as T),
        signal: options.signal,
      };
      const node = state.pending.enqueue(task);

      if (options.signal !== undefined) {
        const onAbort = () => {
          if (!state.pending.remove(node)) {
            return;
          }

          task.removeAbortListener();
          reject(getAbortError(options.signal as AbortSignal));
          this.deleteStateIfIdle(key, state);
        };

        options.signal.addEventListener("abort", onAbort, { once: true });
        task.removeAbortListener = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };

        if (options.signal.aborted) {
          onAbort();
        }
      }
    });

    this.startNext(key, state);
    return result;
  }

  private getOrCreateState(key: Key): KeyState {
    const existing = this.states.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const state: KeyState = {
      pending: new FifoQueue<QueuedTask>(),
      running: false,
    };
    this.states.set(key, state);
    return state;
  }

  private startNext(key: Key, state: KeyState): void {
    if (state.running) {
      return;
    }

    const task = state.pending.dequeue();
    if (task === undefined) {
      this.deleteStateIfIdle(key, state);
      return;
    }

    state.running = true;
    task.removeAbortListener();
    void this.executeTask(key, state, task);
  }

  private async executeTask(
    key: Key,
    state: KeyState,
    task: QueuedTask,
  ): Promise<void> {
    try {
      // 保证 enqueue 不会在返回前同步调用用户代码。
      await Promise.resolve();
      throwIfAborted(task.signal);
      task.resolve(await task.operation(task.signal));
    } catch (error: unknown) {
      task.reject(error);
    } finally {
      state.running = false;
      this.startNext(key, state);
    }
  }

  private deleteStateIfIdle(key: Key, state: KeyState): void {
    if (
      !state.running &&
      state.pending.size === 0 &&
      this.states.get(key) === state
    ) {
      this.states.delete(key);
    }
  }
}
