import {
  abortableSleep,
  normalizeError,
  StructuredLogger,
  TraceContext,
} from "../../../../src/foundation/index.js";
import { TaskExecutor } from "../../../../src/runtime/index.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

export function createTaskExecutor(concurrencyLimit: number): {
  readonly executor: TaskExecutor;
  readonly traceContext: TraceContext;
} {
  const traceContext = new TraceContext();
  const logger = new StructuredLogger({
    clock: () => new Date(),
    minLevel: "error",
    scope: "benchmark",
    sink() {},
    traceContext,
  });
  return {
    executor: new TaskExecutor({
      concurrencyLimit,
      logger,
      traceContext,
    }),
    traceContext,
  };
}

export async function captureErrorCode(
  operation: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (cause: unknown) {
    return normalizeError(cause).code;
  }
}

export async function waitUntil(
  predicate: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  while (!predicate()) {
    await abortableSleep(1, signal);
  }
}

export function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
