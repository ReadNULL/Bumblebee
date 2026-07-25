import type { ErrorCode } from "../../foundation/index.js";

export interface SubAgentRunRequest {
  readonly cwd: string;
  readonly task: string;
}

export interface SubAgentExecutionRequest extends SubAgentRunRequest {
  readonly signal: AbortSignal;
}

export interface SubAgentUsage {
  readonly assistantTurns: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SubAgentExecutionOutput {
  readonly model?: string;
  readonly output: string;
  readonly usage?: Partial<SubAgentUsage>;
}

/** 领域层只依赖该端口，具体 Agent 会话由 integration 适配器创建。 */
export interface SubAgentExecutor {
  execute(
    request: SubAgentExecutionRequest,
  ): Promise<SubAgentExecutionOutput>;
}

export interface SubAgentCompletedResult {
  readonly model?: string;
  readonly omittedOutputBytes: number;
  readonly output: string;
  readonly outputBytes: number;
  readonly status: "completed";
  readonly truncated: boolean;
  readonly usage: SubAgentUsage;
}

export interface SubAgentFailedResult {
  readonly errorCode: ErrorCode;
  readonly message: string;
  readonly status: "failed";
}

export interface SubAgentTimedOutResult {
  readonly errorCode: ErrorCode;
  readonly message: string;
  readonly status: "timed_out";
  readonly timeoutMs: number;
}

export interface SubAgentCancelledResult {
  readonly errorCode: ErrorCode;
  readonly message: string;
  readonly status: "cancelled";
}

export type SubAgentRunResult =
  | SubAgentCancelledResult
  | SubAgentCompletedResult
  | SubAgentFailedResult
  | SubAgentTimedOutResult;
