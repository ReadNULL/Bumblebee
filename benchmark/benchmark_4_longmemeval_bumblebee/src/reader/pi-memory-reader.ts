import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  BumblebeeError,
  ERROR_CODES,
  withTimeout,
} from "../../../../src/foundation/index.js";
import type {
  LongMemEvalReader,
  LongMemEvalReaderInput,
  LongMemEvalReaderOutput,
} from "../contracts/index.js";

export interface PiMemoryReaderOptions {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly timeoutMs: number;
}

/** 每题使用独立的无工具、内存会话，避免答案在题目之间相互污染。 */
export class PiMemoryReader implements LongMemEvalReader {
  constructor(private readonly options: PiMemoryReaderOptions) {}

  async answer(
    input: LongMemEvalReaderInput,
  ): Promise<LongMemEvalReaderOutput> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(
      this.options.provider,
      this.options.model,
    );
    if (model === undefined) {
      throw new BumblebeeError(
        "The requested pi model is not configured",
        {
          code: ERROR_CODES.NOT_FOUND,
          context: {
            provider: this.options.provider,
            model: this.options.model,
          },
          userMessage:
            "没有找到指定模型，请先在 pi 中使用 /model 完成配置。",
        },
      );
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => this.options.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: this.options.cwd,
      authStorage,
      modelRegistry,
      model,
      ...(this.options.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: this.options.thinkingLevel }),
      noTools: "all",
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.options.cwd),
      settingsManager,
    });
    const started = performance.now();
    try {
      await withTimeout(
        async (timeoutSignal) => {
          const abort = () => {
            void session.abort();
          };
          timeoutSignal.addEventListener("abort", abort, {
            once: true,
          });
          try {
            await session.prompt(buildPiMemoryPrompt(input), {
              expandPromptTemplates: false,
            });
          } finally {
            timeoutSignal.removeEventListener("abort", abort);
          }
        },
        {
          operationName: `LongMemEval case ${input.caseId}`,
          timeoutMs: this.options.timeoutMs,
          ...(input.signal === undefined
            ? {}
            : { signal: input.signal }),
        },
      );
      const answer = session.getLastAssistantText()?.trim();
      if (answer === undefined || answer.length === 0) {
        throw new BumblebeeError(
          "pi returned no assistant answer",
          { code: ERROR_CODES.UNAVAILABLE },
        );
      }
      const stats = session.getSessionStats();
      return Object.freeze({
        answer,
        durationMs: Math.max(0, performance.now() - started),
        tokens: Object.freeze({
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
        }),
        costUsd: stats.cost,
      });
    } finally {
      session.dispose();
    }
  }
}

export function buildPiMemoryPrompt(
  input: LongMemEvalReaderInput,
): string {
  const context = input.memoryContext.trim().length > 0
    ? input.memoryContext
    : "(没有检索到匹配的持久记忆。)";
  return [
    "以下是 Bumblebee 为当前问题检索出的持久记忆上下文：",
    context,
    "",
    "当前问题：",
    input.question,
    "",
    "请只依据上述上下文作答。",
  ].join("\n");
}
