import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";
import { getAbortError, throwIfAborted } from "./abort.js";
import { validateDurationMs } from "./duration.js";

export interface TimeoutOptions {
  readonly operationName?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

type OperationOutcome<T> =
  | { readonly kind: "aborted"; readonly error: BumblebeeError }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "succeeded"; readonly value: T };

/**
 * 为异步操作创建子 AbortSignal，并区分父级取消与本地超时。
 * 即使操作忽略 signal，调用方也会停止等待；底层工作仍需自行协作退出。
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  options: TimeoutOptions,
): Promise<T> {
  const timeoutMs = validateDurationMs(
    options.timeoutMs,
    "timeoutMs",
    false,
  );
  const operationName = options.operationName?.trim() || "operation";

  throwIfAborted(options.signal);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  let removeParentListener = () => {};

  try {
    if (options.signal !== undefined) {
      const onParentAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(getAbortError(options.signal as AbortSignal));
        }
      };

      options.signal.addEventListener("abort", onParentAbort, { once: true });
      removeParentListener = () => {
        options.signal?.removeEventListener("abort", onParentAbort);
      };

      if (options.signal.aborted) {
        onParentAbort();
      }
    }

    throwIfAborted(controller.signal);

    const timeoutError = new BumblebeeError(
      `${operationName} timed out after ${timeoutMs}ms`,
      {
        code: ERROR_CODES.TIMEOUT,
        context: { operationName, timeoutMs },
      },
    );

    timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(timeoutError);
      }
    }, timeoutMs);

    const abortOutcome = new Promise<OperationOutcome<T>>((resolve) => {
      const onAbort = () => {
        resolve({
          kind: "aborted",
          error: getAbortError(controller.signal),
        });
      };

      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        controller.signal.removeEventListener("abort", onAbort);
      };

      if (controller.signal.aborted) {
        onAbort();
      }
    });

    const operationOutcome = Promise.resolve()
      .then(() => operation(controller.signal))
      .then<OperationOutcome<T>, OperationOutcome<T>>(
        (value) => ({ kind: "succeeded", value }),
        (error: unknown) => ({ kind: "failed", error }),
      );

    const outcome = await Promise.race([operationOutcome, abortOutcome]);

    switch (outcome.kind) {
      case "succeeded":
        return outcome.value;
      case "aborted":
      case "failed":
        throw outcome.error;
      default:
        return assertNever(outcome);
    }
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    removeAbortListener();
    removeParentListener();
  }
}

function assertNever(value: never): never {
  throw new BumblebeeError("Unexpected operation outcome", {
    code: ERROR_CODES.INTERNAL,
    context: { value },
  });
}
