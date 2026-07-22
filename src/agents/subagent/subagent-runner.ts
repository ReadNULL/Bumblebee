import { Buffer } from "node:buffer";

import {
  BumblebeeError,
  ERROR_CODES,
  getUserMessage,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import type {
  SubAgentCompletedResult,
  SubAgentExecutionOutput,
  SubAgentExecutor,
  SubAgentRunRequest,
  SubAgentRunResult,
  SubAgentUsage,
} from "./types.js";

export const MAX_SUBAGENT_TASK_LENGTH = 8_000;
export const DEFAULT_SUBAGENT_OUTPUT_BYTES = 32 * 1024;
const MAX_CWD_LENGTH = 4_096;
const MAX_MODEL_NAME_LENGTH = 256;

export interface SubAgentRunnerOptions {
  readonly maxOutputBytes?: number;
}

/** 对任务输入和输出设界，实际模型调用通过 SubAgentExecutor 端口注入。 */
export class SubAgentRunner {
  private readonly maxOutputBytes: number;

  constructor(
    private readonly executor: SubAgentExecutor,
    options: SubAgentRunnerOptions = {},
  ) {
    this.maxOutputBytes = normalizePositiveInteger(
      options.maxOutputBytes ?? DEFAULT_SUBAGENT_OUTPUT_BYTES,
      "maxOutputBytes",
    );
  }

  async run(
    request: SubAgentRunRequest,
    signal: AbortSignal,
  ): Promise<SubAgentCompletedResult> {
    const normalized = normalizeRequest(request);
    throwIfAborted(signal);

    const execution = await this.executor.execute({
      ...normalized,
      signal,
    });
    throwIfAborted(signal);

    return createCompletedResult(execution, this.maxOutputBytes);
  }
}

export function createSubAgentErrorResult(
  cause: unknown,
  timeoutMs: number,
): Exclude<SubAgentRunResult, SubAgentCompletedResult> {
  const error = normalizeError(cause, {
    message: "Sub-agent execution failed",
    userMessage: "子 Agent 执行失败，请检查当前模型与鉴权配置。",
  });

  if (error.code === ERROR_CODES.TIMEOUT) {
    return Object.freeze({
      errorCode: error.code,
      message: `子 Agent 在 ${formatDuration(timeoutMs)}内未完成。`,
      status: "timed_out",
      timeoutMs,
    });
  }
  if (error.code === ERROR_CODES.CANCELLED) {
    return Object.freeze({
      errorCode: error.code,
      message: "子 Agent 已取消。",
      status: "cancelled",
    });
  }

  return Object.freeze({
    errorCode: error.code,
    message: getUserMessage(
      error,
      "子 Agent 执行失败，请检查当前模型与鉴权配置。",
    ),
    status: "failed",
  });
}

function normalizeRequest(request: SubAgentRunRequest): SubAgentRunRequest {
  if (typeof request !== "object" || request === null) {
    throw invalidInput("Sub-agent request must be an object", "request");
  }

  return Object.freeze({
    cwd: normalizeText(request.cwd, "cwd", MAX_CWD_LENGTH),
    task: normalizeText(
      request.task,
      "task",
      MAX_SUBAGENT_TASK_LENGTH,
    ),
  });
}

function createCompletedResult(
  execution: SubAgentExecutionOutput,
  maximumBytes: number,
): SubAgentCompletedResult {
  if (typeof execution !== "object" || execution === null) {
    throw new BumblebeeError("Sub-agent returned an invalid result", {
      code: ERROR_CODES.INTERNAL,
      userMessage: "子 Agent 返回了无效结果。",
    });
  }

  const rawOutput = typeof execution.output === "string"
    ? execution.output.trim()
    : "";
  if (rawOutput.length === 0) {
    throw new BumblebeeError("Sub-agent returned no text output", {
      code: ERROR_CODES.UNAVAILABLE,
      userMessage: "子 Agent 未返回可用的文本结果。",
    });
  }

  const truncated = truncateUtf8(rawOutput, maximumBytes);
  const model = normalizeOptionalModel(execution.model);

  return Object.freeze({
    ...(model === undefined ? {} : { model }),
    omittedOutputBytes: truncated.omittedBytes,
    output: truncated.output,
    outputBytes: truncated.outputBytes,
    status: "completed",
    truncated: truncated.omittedBytes > 0,
    usage: normalizeUsage(execution.usage),
  });
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): {
  readonly omittedBytes: number;
  readonly output: string;
  readonly outputBytes: number;
} {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maximumBytes) {
    return { omittedBytes: 0, output: value, outputBytes: totalBytes };
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidateBytes = Buffer.byteLength(value.slice(0, middle), "utf8");
    if (candidateBytes <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  // 避免在 UTF-16 代理对中间截断非 BMP 字符。
  if (
    low > 0 &&
    low < value.length &&
    isHighSurrogate(value.charCodeAt(low - 1)) &&
    isLowSurrogate(value.charCodeAt(low))
  ) {
    low -= 1;
  }

  const output = value.slice(0, low).trimEnd();
  const outputBytes = Buffer.byteLength(output, "utf8");
  return {
    omittedBytes: totalBytes - outputBytes,
    output,
    outputBytes,
  };
}

function normalizeUsage(
  usage: Partial<SubAgentUsage> | undefined,
): SubAgentUsage {
  return Object.freeze({
    assistantTurns: normalizeMetric(usage?.assistantTurns),
    cacheReadTokens: normalizeMetric(usage?.cacheReadTokens),
    cacheWriteTokens: normalizeMetric(usage?.cacheWriteTokens),
    costUsd: normalizeMetric(usage?.costUsd),
    inputTokens: normalizeMetric(usage?.inputTokens),
    outputTokens: normalizeMetric(usage?.outputTokens),
    totalTokens: normalizeMetric(usage?.totalTokens),
  });
}

function normalizeMetric(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeOptionalModel(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_MODEL_NAME_LENGTH
    ? normalized
    : undefined;
}

function normalizeText(
  value: string,
  fieldName: string,
  maximumLength: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw invalidInput(
      `${fieldName} must contain 1 to ${maximumLength} characters`,
      fieldName,
    );
  }
  return normalized;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`${fieldName} must be a positive safe integer`, fieldName);
  }
  return value;
}

function invalidInput(message: string, fieldName: string): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context: { fieldName },
  });
}

function formatDuration(value: number): string {
  return value % 1_000 === 0
    ? `${value / 1_000} 秒`
    : `${value} 毫秒`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
