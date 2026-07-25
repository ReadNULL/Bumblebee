import {
  BumblebeeError,
  ERROR_CODES,
  KeyedSerialQueue,
  normalizeError,
  Semaphore,
  type StructuredLogger,
  TraceContext,
  withTimeout,
} from "../foundation/index.js";
import type {
  TaskExecutionContext,
  TaskExecutionRequest,
  TaskExecutorStatus,
  TaskOperation,
} from "./types.js";

const MAX_OPERATION_NAME_LENGTH = 128;
const MAX_SESSION_KEY_LENGTH = 512;

export interface TaskExecutorOptions {
  readonly concurrencyLimit: number;
  readonly logger: StructuredLogger;
  readonly signal?: AbortSignal;
  readonly traceContext: TraceContext;
}

interface NormalizedTaskRequest {
  readonly operationName: string;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceId?: string;
}

/**
 * 组合基础积木形成统一任务入口，不包含任何 pi 或业务领域逻辑。
 * 同一 sessionKey 串行，不同 sessionKey 共享全局并发配额。
 */
export class TaskExecutor {
  private accepting = true;
  private readonly controller = new AbortController();
  private disposalPromise: Promise<void> | undefined;
  private readonly logger: StructuredLogger;
  private readonly outstandingWork = new Set<Promise<unknown>>();
  private readonly runtimeSignal: AbortSignal;
  private readonly sessions = new KeyedSerialQueue<string>();
  private readonly slots: Semaphore;
  private readonly traceContext: TraceContext;

  constructor(options: TaskExecutorOptions) {
    this.logger = options.logger;
    this.traceContext = options.traceContext;
    this.slots = new Semaphore(options.concurrencyLimit);
    this.runtimeSignal =
      options.signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, options.signal]);
  }

  get status(): TaskExecutorStatus {
    return Object.freeze({
      accepting: this.accepting,
      activeOperationCount: this.slots.activeCount,
      activeSessionCount: this.sessions.activeKeyCount,
      pendingOperationCount:
        this.sessions.pendingCount + this.slots.pendingCount,
    });
  }

  async execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T> {
    if (!this.accepting) {
      throw new BumblebeeError("Task executor is not accepting new work", {
        code: ERROR_CODES.CONFLICT,
      });
    }

    if (typeof operation !== "function") {
      throw new BumblebeeError("Task operation must be a function", {
        code: ERROR_CODES.INVALID_INPUT,
      });
    }

    const normalizedRequest = normalizeRequest(request);

    return await this.traceContext.run(
      () => this.executeInTrace(normalizedRequest, operation),
      normalizedRequest.traceId,
    );
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== undefined) {
      return this.disposalPromise;
    }

    this.accepting = false;
    if (!this.controller.signal.aborted) {
      this.controller.abort(
        new BumblebeeError("Task executor disposed", {
          code: ERROR_CODES.CANCELLED,
        }),
      );
    }

    const promise = this.drainOutstandingWork();
    this.disposalPromise = promise;
    return promise;
  }

  private executeInTrace<T>(
    request: NormalizedTaskRequest,
    operation: TaskOperation<T>,
  ): Promise<T> {
    const traceId = this.traceContext.getTraceId();
    if (traceId === undefined) {
      return Promise.reject(
        new BumblebeeError("Task trace context is unavailable", {
          code: ERROR_CODES.INTERNAL,
        }),
      );
    }

    const requestSignal =
      request.signal === undefined
        ? this.runtimeSignal
        : AbortSignal.any([this.runtimeSignal, request.signal]);
    const taskLogger = this.logger.child("task", {
      operationName: request.operationName,
      sessionKey: request.sessionKey,
    });

    taskLogger.debug("task accepted");

    let outcome: Promise<T>;
    if (request.timeoutMs === undefined) {
      outcome = this.startPipeline(
        request,
        requestSignal,
        traceId,
        taskLogger,
        operation,
      );
    } else {
      outcome = withTimeout(
        (timeoutSignal) =>
          this.startPipeline(
            request,
            timeoutSignal,
            traceId,
            taskLogger,
            operation,
          ),
        {
          operationName: request.operationName,
          signal: requestSignal,
          timeoutMs: request.timeoutMs,
        },
      );
    }

    const observed = outcome.then(
      (value) => {
        taskLogger.debug("task completed");
        return value;
      },
      (cause: unknown) => {
        const error = normalizeError(cause, {
          context: {
            operationName: request.operationName,
            sessionKey: request.sessionKey,
          },
          message: "Task execution failed",
        });

        if (error.code === ERROR_CODES.CANCELLED) {
          taskLogger.debug("task cancelled", { error });
        } else if (error.code === ERROR_CODES.TIMEOUT) {
          taskLogger.warn("task timed out", { error });
        } else {
          taskLogger.error("task failed", { error });
        }

        throw error;
      },
    );

    this.trackForDisposal(observed);
    return observed;
  }

  private startPipeline<T>(
    request: NormalizedTaskRequest,
    signal: AbortSignal,
    traceId: string,
    logger: StructuredLogger,
    operation: TaskOperation<T>,
  ): Promise<T> {
    const pipeline = this.sessions.enqueue(
      request.sessionKey,
      (sessionSignal) => {
        const activeSessionSignal = sessionSignal ?? signal;

        return this.slots.runExclusive(
          async (limitedSignal) => {
            const operationSignal = limitedSignal ?? activeSessionSignal;
            const context = Object.freeze<TaskExecutionContext>({
              logger,
              signal: operationSignal,
              traceId,
            });

            logger.debug("task started");
            return await operation(context);
          },
          { signal: activeSessionSignal },
        );
      },
      { signal },
    );

    // withTimeout 可以先返回，但真正的底层操作仍需保留到退出时完成清理。
    this.trackForDisposal(pipeline);
    return pipeline;
  }

  private trackForDisposal(promise: Promise<unknown>): void {
    this.outstandingWork.add(promise);
    void promise.then(
      () => {
        this.outstandingWork.delete(promise);
      },
      () => {
        this.outstandingWork.delete(promise);
      },
    );
  }

  private async drainOutstandingWork(): Promise<void> {
    // 让已经返回给调用方的 execute() 有机会登记其底层 pipeline。
    await Promise.resolve();

    while (this.outstandingWork.size > 0) {
      await Promise.allSettled([...this.outstandingWork]);
    }
  }
}

function normalizeRequest(
  request: TaskExecutionRequest,
): NormalizedTaskRequest {
  if (typeof request !== "object" || request === null) {
    throw new BumblebeeError("Task request must be an object", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }

  const operationName = normalizeBoundedText(
    request.operationName,
    "operationName",
    MAX_OPERATION_NAME_LENGTH,
  );
  const sessionKey = normalizeBoundedText(
    request.sessionKey,
    "sessionKey",
    MAX_SESSION_KEY_LENGTH,
  );

  return Object.freeze({
    operationName,
    sessionKey,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
  });
}

function normalizeBoundedText(
  value: string,
  fieldName: string,
  maximumLength: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new BumblebeeError(
      `${fieldName} must contain 1 to ${maximumLength} characters`,
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName, maximumLength },
      },
    );
  }

  return normalized;
}
