import type {
  LifecycleState,
  StructuredLogger,
} from "../foundation/index.js";

/** 调用方为一项任务提供的调度和取消信息。 */
export interface TaskExecutionRequest {
  readonly operationName: string;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceId?: string;
}

/** 任务真正获得执行许可后收到的运行上下文。 */
export interface TaskExecutionContext {
  readonly logger: StructuredLogger;
  readonly signal: AbortSignal;
  readonly traceId: string;
}

export type TaskOperation<T> = (
  context: TaskExecutionContext,
) => PromiseLike<T> | T;

export interface TaskExecutorStatus {
  readonly accepting: boolean;
  readonly activeOperationCount: number;
  readonly activeSessionCount: number;
  readonly pendingOperationCount: number;
}

export interface BumblebeeRuntimeStatus {
  readonly state: LifecycleState;
  readonly tasks?: TaskExecutorStatus;
}
