import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createSubAgentErrorResult,
  MAX_SUBAGENT_TASK_LENGTH,
  SubAgentRunner,
  type SubAgentExecutor,
  type SubAgentRunResult,
} from "../../agents/index.js";
import {
  ERROR_CODES,
  normalizeError,
} from "../../foundation/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../runtime/index.js";
import { PiSubAgentExecutor } from "./pi-subagent-executor.js";

export const DELEGATE_TASK_TOOL_NAME = "delegate_task";
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 5 * 60 * 1_000;

const DELEGATE_TASK_PARAMETERS = {
  additionalProperties: false,
  properties: {
    task: {
      description:
        "One self-contained read-only codebase investigation task",
      maxLength: MAX_SUBAGENT_TASK_LENGTH,
      minLength: 1,
      type: "string",
    },
  },
  required: ["task"],
  type: "object",
} as const;

export interface SubAgentExecutionRuntime {
  execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T>;
}

export type PiSubAgentExecutorFactory = (
  context: ExtensionContext,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
) => SubAgentExecutor;

export interface PiSubAgentBindingOptions {
  readonly executorFactory?: PiSubAgentExecutorFactory;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

/** 将一个受控只读子任务注册为 Pi 工具，不在领域层暴露 Pi 类型。 */
export function bindPiSubAgent(
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "registerTool">,
  runtime: SubAgentExecutionRuntime,
  options: PiSubAgentBindingOptions = {},
): void {
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
    "timeoutMs",
  );
  const executorFactory = options.executorFactory ?? createDefaultExecutor;

  pi.registerTool({
    description: [
      "Delegate one independent codebase investigation to an isolated read-only sub-agent.",
      "The child can only use read, grep, find, and ls inside the current workspace.",
      "Use this for focused exploration that would otherwise add substantial context to the main conversation.",
    ].join(" "),
    executionMode: "sequential",
    label: "Delegate Task",
    name: DELEGATE_TASK_TOOL_NAME,
    parameters: DELEGATE_TASK_PARAMETERS,

    async execute(toolCallId, params, signal, _onUpdate, context) {
      const task = parseTask(params);
      let result: SubAgentRunResult;

      try {
        result = await runtime.execute(
          {
            operationName: "subagent.delegate",
            sessionKey:
              `pi:${context.sessionManager.getSessionId()}:subagent`,
            ...(signal === undefined ? {} : { signal }),
            timeoutMs,
            traceId: toolCallId,
          },
          async ({ logger, signal: runtimeSignal }) => {
            const runner = new SubAgentRunner(
              executorFactory(context, pi.getThinkingLevel()),
              {
                ...(options.maxOutputBytes === undefined
                  ? {}
                  : { maxOutputBytes: options.maxOutputBytes }),
              },
            );
            const completed = await runner.run(
              { cwd: context.cwd, task },
              runtimeSignal,
            );

            logger.info("sub-agent completed", {
              fields: {
                model: completed.model ?? "unknown",
                omittedOutputBytes: completed.omittedOutputBytes,
                outputBytes: completed.outputBytes,
                status: completed.status,
                toolCallId,
                truncated: completed.truncated,
              },
            });
            return completed;
          },
        );
      } catch (cause: unknown) {
        result = createSubAgentErrorResult(cause, timeoutMs);
        if (result.status === "cancelled") {
          throw normalizeError(cause, {
            code: ERROR_CODES.CANCELLED,
            message: "Sub-agent tool call cancelled",
          });
        }
      }

      return toToolResult(result);
    },
  });
}

function createDefaultExecutor(
  context: ExtensionContext,
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): SubAgentExecutor {
  return new PiSubAgentExecutor({
    model: context.model,
    modelRegistry: context.modelRegistry,
    thinkingLevel,
  });
}

function toToolResult(result: SubAgentRunResult) {
  if (result.status === "completed") {
    const truncationNotice = result.truncated
      ? `\n\n[输出已截断，省略 ${result.omittedOutputBytes} 字节]`
      : "";
    return {
      content: [
        { type: "text" as const, text: `${result.output}${truncationNotice}` },
      ],
      details: result,
    };
  }

  return {
    content: [{ type: "text" as const, text: result.message }],
    details: result,
  };
}

function parseTask(value: unknown): string {
  if (!isRecord(value)) {
    throw invalidToolInput();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== "task" ||
    typeof value.task !== "string" ||
    value.task.trim().length === 0 ||
    value.task.trim().length > MAX_SUBAGENT_TASK_LENGTH
  ) {
    throw invalidToolInput();
  }
  return value.task.trim();
}

function invalidToolInput(): TypeError {
  return new TypeError(
    `delegate_task requires one task string up to ${MAX_SUBAGENT_TASK_LENGTH} characters`,
  );
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
