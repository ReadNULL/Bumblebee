import {
  BumblebeeError,
  ERROR_CODES,
  Lifecycle,
  LIFECYCLE_STATES,
  type LifecycleInitializeOptions,
  type LogLevel,
  type LogSink,
  StructuredLogger,
  TraceContext,
} from "../foundation/index.js";
import { TaskExecutor } from "./task-executor.js";
import type {
  BumblebeeRuntimeStatus,
  TaskExecutionRequest,
  TaskOperation,
} from "./types.js";

const DEFAULT_CONCURRENCY_LIMIT = 4;

export interface BumblebeeRuntimeOptions {
  readonly clock?: () => Date;
  readonly concurrencyLimit?: number;
  readonly logSink?: LogSink;
  readonly minLogLevel?: LogLevel;
}

interface RuntimeResources {
  readonly executor: TaskExecutor;
}

/** 运行时组合根：只拥有基础资源，不承载角色、渠道等业务职责。 */
export class BumblebeeRuntime {
  private readonly clock: () => Date;
  private readonly concurrencyLimit: number;
  private readonly lifecycle = new Lifecycle();
  private readonly logSink: LogSink;
  private readonly minLogLevel: LogLevel;
  private resources: RuntimeResources | undefined;

  constructor(options: BumblebeeRuntimeOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.concurrencyLimit =
      options.concurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT;
    // pi 管理终端渲染，默认不直接写 stdout，避免破坏 TUI。
    this.logSink = options.logSink ?? (() => {});
    this.minLogLevel = options.minLogLevel ?? "info";
  }

  get status(): BumblebeeRuntimeStatus {
    return Object.freeze({
      state: this.lifecycle.state,
      ...(this.resources === undefined
        ? {}
        : { tasks: this.resources.executor.status }),
    });
  }

  initialize(options: LifecycleInitializeOptions = {}): Promise<void> {
    return this.lifecycle.initialize(({ defer, signal }) => {
      const traceContext = new TraceContext();
      defer("trace-context", () => traceContext.dispose());

      const logger = new StructuredLogger({
        clock: this.clock,
        minLevel: this.minLogLevel,
        scope: "bumblebee",
        sink: this.logSink,
        traceContext,
      });
      const executor = new TaskExecutor({
        concurrencyLimit: this.concurrencyLimit,
        logger,
        signal,
        traceContext,
      });
      defer("task-executor", () => executor.dispose());

      logger.info("runtime initialized", {
        fields: { concurrencyLimit: this.concurrencyLimit },
      });
      this.resources = Object.freeze({ executor });
    }, options);
  }

  execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T> {
    if (
      this.lifecycle.state !== LIFECYCLE_STATES.READY ||
      this.resources === undefined
    ) {
      return Promise.reject(
        new BumblebeeError("Bumblebee runtime is not ready", {
          code: ERROR_CODES.CONFLICT,
          context: { state: this.lifecycle.state },
        }),
      );
    }

    return this.resources.executor.execute(request, operation);
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}
