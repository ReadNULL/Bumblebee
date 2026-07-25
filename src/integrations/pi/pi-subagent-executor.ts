import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  SubAgentExecutionOutput,
  SubAgentExecutionRequest,
  SubAgentExecutor,
} from "../../agents/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import {
  createReadOnlyWorkspaceGuard,
  PI_READ_ONLY_TOOL_NAMES,
} from "./read-only-workspace-guard.js";

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a read-only coding sub-agent with an isolated context.",
  "Investigate only the delegated task inside the current workspace.",
  "Do not attempt to modify files or execute shell commands.",
  "Return concise findings with concrete file references and clearly state uncertainty.",
].join(" ");

type PiModel = NonNullable<ExtensionContext["model"]>;
type PiModelRegistry = ExtensionContext["modelRegistry"];
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface PiSubAgentSessionStats {
  readonly assistantMessages: number;
  readonly cost: number;
  readonly tokens: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
  };
}

export interface PiSubAgentSession {
  readonly isStreaming: boolean;
  readonly model: { readonly id: string; readonly provider: string } | undefined;
  readonly state: { readonly messages: readonly unknown[] };
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames(): string[];
  getSessionStats(): PiSubAgentSessionStats;
  prompt(
    text: string,
    options: {
      readonly expandPromptTemplates: false;
      readonly source: "extension";
    },
  ): Promise<void>;
}

export interface PiSubAgentSessionFactoryOptions {
  readonly cwd: string;
  readonly model: PiModel;
  readonly modelRegistry: PiModelRegistry;
  readonly thinkingLevel: PiThinkingLevel;
}

export type PiSubAgentSessionFactory = (
  options: PiSubAgentSessionFactoryOptions,
) => Promise<PiSubAgentSession>;

export interface PiSubAgentExecutorOptions {
  readonly model: ExtensionContext["model"];
  readonly modelRegistry: PiModelRegistry;
  readonly sessionFactory?: PiSubAgentSessionFactory;
  readonly thinkingLevel: PiThinkingLevel;
}

/** 使用 Pi SDK 创建内存子会话；不加载外部扩展，也不持久化子会话。 */
export class PiSubAgentExecutor implements SubAgentExecutor {
  private readonly model: ExtensionContext["model"];
  private readonly modelRegistry: PiModelRegistry;
  private readonly sessionFactory: PiSubAgentSessionFactory;
  private readonly thinkingLevel: PiThinkingLevel;

  constructor(options: PiSubAgentExecutorOptions) {
    this.model = options.model;
    this.modelRegistry = options.modelRegistry;
    this.sessionFactory = options.sessionFactory ?? createDefaultSession;
    this.thinkingLevel = options.thinkingLevel;
  }

  async execute(
    request: SubAgentExecutionRequest,
  ): Promise<SubAgentExecutionOutput> {
    throwIfAborted(request.signal);
    if (this.model === undefined) {
      throw new BumblebeeError("Current pi model is unavailable", {
        code: ERROR_CODES.UNAVAILABLE,
        userMessage: "当前没有可供子 Agent 使用的模型，请先通过 /model 选择模型。",
      });
    }

    let session: PiSubAgentSession;
    try {
      session = await this.sessionFactory({
        cwd: request.cwd,
        model: this.model,
        modelRegistry: this.modelRegistry,
        thinkingLevel: this.thinkingLevel,
      });
    } catch (cause: unknown) {
      throw normalizePiFailure(cause, "Unable to create sub-agent session");
    }

    let abortPromise: Promise<AbortOutcome> | undefined;
    let executionFailure: unknown;
    let hasExecutionFailure = false;
    let output: SubAgentExecutionOutput | undefined;

    const requestAbort = (): void => {
      abortPromise ??= session.abort().then<AbortOutcome, AbortOutcome>(
        () => ({ status: "succeeded" }),
        (cause: unknown) => ({ cause, status: "failed" }),
      );
    };
    const onAbort = (): void => requestAbort();

    if (request.signal.aborted) {
      requestAbort();
    } else {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      assertReadOnlyToolSet(session.getActiveToolNames());
      throwIfAborted(request.signal);
      await session.prompt(request.task, {
        expandPromptTemplates: false,
        source: "extension",
      });
      throwIfAborted(request.signal);

      const stats = session.getSessionStats();
      output = Object.freeze({
        ...(session.model === undefined
          ? {}
          : { model: `${session.model.provider}/${session.model.id}` }),
        output: extractFinalAssistantText(session.state.messages),
        usage: Object.freeze({
          assistantTurns: stats.assistantMessages,
          cacheReadTokens: stats.tokens.cacheRead,
          cacheWriteTokens: stats.tokens.cacheWrite,
          costUsd: stats.cost,
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          totalTokens: stats.tokens.total,
        }),
      });
    } catch (cause: unknown) {
      hasExecutionFailure = true;
      executionFailure = cause;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (session.isStreaming) {
        requestAbort();
      }

      const abortOutcome = await abortPromise;
      session.dispose();

      if (abortOutcome?.status === "failed") {
        executionFailure = hasExecutionFailure
          ? new AggregateError(
              [executionFailure, abortOutcome.cause],
              "Sub-agent execution and abort both failed",
            )
          : abortOutcome.cause;
        hasExecutionFailure = true;
      }
    }

    if (request.signal.aborted) {
      throwIfAborted(request.signal);
    }
    if (hasExecutionFailure) {
      throw normalizePiFailure(
        executionFailure,
        "Sub-agent session execution failed",
      );
    }
    if (output === undefined) {
      throw new BumblebeeError("Sub-agent produced no execution result", {
        code: ERROR_CODES.INTERNAL,
        userMessage: "子 Agent 未返回可用结果。",
      });
    }
    return output;
  }
}

type AbortOutcome =
  | { readonly status: "succeeded" }
  | { readonly cause: unknown; readonly status: "failed" };

async function createDefaultSession(
  options: PiSubAgentSessionFactoryOptions,
): Promise<PiSubAgentSession> {
  const agentDir = getAgentDir();
  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    appendSystemPrompt: [SUBAGENT_SYSTEM_PROMPT],
    cwd: options.cwd,
    extensionFactories: [createReadOnlyWorkspaceGuard()],
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    agentDir,
    cwd: options.cwd,
    model: options.model,
    modelRegistry: options.modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    sessionStartEvent: { reason: "startup", type: "session_start" },
    thinkingLevel: options.thinkingLevel,
    tools: [...PI_READ_ONLY_TOOL_NAMES],
  });

  if (result.extensionsResult.errors.length > 0) {
    result.session.dispose();
    throw new AggregateError(
      result.extensionsResult.errors.map(
        (item) => new Error(`${item.path}: ${item.error}`),
      ),
      "Unable to load the sub-agent permission guard",
    );
  }
  return result.session;
}

function assertReadOnlyToolSet(toolNames: readonly string[]): void {
  const actual = [...new Set(toolNames)].sort();
  const expected = [...PI_READ_ONLY_TOOL_NAMES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new BumblebeeError("Sub-agent tool isolation is invalid", {
      code: ERROR_CODES.CONFLICT,
      context: { activeToolNames: actual },
      userMessage: "子 Agent 的只读工具隔离未能建立。",
    });
  }
}

function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content.flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    ).join("");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

function normalizePiFailure(
  cause: unknown,
  message: string,
): BumblebeeError {
  return normalizeError(cause, {
    code: ERROR_CODES.UNAVAILABLE,
    message,
    retryable: true,
    userMessage: "子 Agent 调用失败，请检查当前模型与鉴权配置。",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
