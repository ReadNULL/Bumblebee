import {
  BumblebeeError,
  ERROR_CODES,
  isBumblebeeError,
} from "../errors/index.js";

/** 在协作式任务检查点抛出统一的取消或超时错误。 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw getAbortError(signal);
  }
}

/**
 * 保留由外层 Bumblebee 原语写入 signal.reason 的错误身份。
 * 原生 AbortError、字符串或其他原因统一包装为 CANCELLED，并通过 cause 留存。
 */
export function getAbortError(signal: AbortSignal): BumblebeeError {
  if (isBumblebeeError(signal.reason)) {
    return signal.reason;
  }

  return new BumblebeeError("Operation cancelled", {
    code: ERROR_CODES.CANCELLED,
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
}
