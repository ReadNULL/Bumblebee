import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";

const MAX_TRACE_ID_LENGTH = 128;

interface TraceState {
  readonly traceId: string;
}

/**
 * 每个 Bumblebee 实例应持有自己的 TraceContext。
 * AsyncLocalStorage 负责跨 await 传播，并隔离并发异步调用链。
 */
export class TraceContext {
  private disposed = false;
  private readonly storage = new AsyncLocalStorage<TraceState>();

  /** 释放 AsyncLocalStorage 关联的异步上下文；重复调用不会产生副作用。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.storage.disable();
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  run<T>(callback: () => T, traceId: string = randomUUID()): T {
    if (this.disposed) {
      throw new BumblebeeError("TraceContext has been disposed", {
        code: ERROR_CODES.CONFLICT,
      });
    }

    const normalizedTraceId = traceId.trim();

    if (
      normalizedTraceId.length === 0 ||
      normalizedTraceId.length > MAX_TRACE_ID_LENGTH
    ) {
      throw new BumblebeeError(
        `traceId must contain 1-${MAX_TRACE_ID_LENGTH} characters`,
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { traceIdLength: normalizedTraceId.length },
        },
      );
    }

    return this.storage.run(
      Object.freeze({ traceId: normalizedTraceId }),
      callback,
    );
  }
}
