import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/index.js";
import {
  createReadOnlyWorkspaceGuard,
  PiSubAgentExecutor,
  type PiSubAgentSession,
  type PiSubAgentSessionFactoryOptions,
} from "../../../src/integrations/pi/index.js";

describe("PiSubAgentExecutor", () => {
  it("inherits pi model settings and disposes an isolated read-only session", async () => {
    const session = createSession();
    let captured: PiSubAgentSessionFactoryOptions | undefined;
    const model = createModel();
    const modelRegistry = createModelRegistry();
    const executor = new PiSubAgentExecutor({
      model,
      modelRegistry,
      sessionFactory: async (options) => {
        captured = options;
        return session;
      },
      thinkingLevel: "medium",
    });
    const signal = new AbortController().signal;

    const result = await executor.execute({
      cwd: path.resolve("virtual-workspace"),
      signal,
      task: "Find the configuration entry point",
    });

    expect(captured).toMatchObject({
      model,
      modelRegistry,
      thinkingLevel: "medium",
    });
    expect(session.getActiveToolNames).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith(
      "Find the configuration entry point",
      { expandPromptTemplates: false, source: "extension" },
    );
    expect(result).toMatchObject({
      model: "test-provider/test-model",
      output: "Final finding.",
      usage: {
        assistantTurns: 1,
        costUsd: 0.01,
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
      },
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("fails before session creation when pi has no selected model", async () => {
    const sessionFactory = vi.fn(async () => createSession());
    const executor = new PiSubAgentExecutor({
      model: undefined,
      modelRegistry: createModelRegistry(),
      sessionFactory,
      thinkingLevel: "medium",
    });

    await expect(
      executor.execute({
        cwd: path.resolve("virtual-workspace"),
        signal: new AbortController().signal,
        task: "Inspect",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAVAILABLE });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("rejects an unexpected active tool and still disposes the session", async () => {
    const session = createSession({
      getActiveToolNames: vi.fn(() => ["read", "grep", "find", "ls", "write"]),
    });
    const executor = createExecutor(session);

    await expect(
      executor.execute({
        cwd: path.resolve("virtual-workspace"),
        signal: new AbortController().signal,
        task: "Inspect",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("propagates cancellation through session.abort before disposal", async () => {
    let finishPrompt: (() => void) | undefined;
    const prompt = vi.fn(
      () => new Promise<void>((resolve) => {
        finishPrompt = resolve;
      }),
    );
    const abort = vi.fn(async () => finishPrompt?.());
    const session = createSession({ abort, prompt });
    const executor = createExecutor(session);
    const controller = new AbortController();

    const execution = executor.execute({
      cwd: path.resolve("virtual-workspace"),
      signal: controller.signal,
      task: "Inspect",
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    controller.abort(
      new BumblebeeError("cancelled by parent", {
        code: ERROR_CODES.CANCELLED,
      }),
    );

    await expect(execution).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

describe("createReadOnlyWorkspaceGuard", () => {
  it("allows workspace reads and blocks external or non-read-only tools", async () => {
    let handler:
      | ExtensionHandler<ToolCallEvent, ToolCallEventResult>
      | undefined;
    const api = {
      on(event: string, candidate: unknown) {
        if (event === "tool_call") {
          handler = candidate as ExtensionHandler<
            ToolCallEvent,
            ToolCallEventResult
          >;
        }
      },
    } as unknown as ExtensionAPI;
    await createReadOnlyWorkspaceGuard()(api);
    if (handler === undefined) {
      throw new Error("expected a tool_call guard");
    }

    const cwd = path.resolve(".");
    const context = {
      cwd,
      signal: undefined,
    } as unknown as ExtensionContext;
    const workspaceRead = await handler(
      toolCall("read", { path: path.join(cwd, "README.md") }),
      context,
    );
    const externalRead = await handler(
      toolCall("read", { path: path.resolve(cwd, "..", "outside.txt") }),
      context,
    );
    const bash = await handler(
      toolCall("bash", { command: "git status" }),
      context,
    );

    expect(workspaceRead).toEqual({});
    expect(externalRead).toMatchObject({ block: true });
    expect(bash).toMatchObject({ block: true });
  });
});

function createExecutor(session: PiSubAgentSession): PiSubAgentExecutor {
  return new PiSubAgentExecutor({
    model: createModel(),
    modelRegistry: createModelRegistry(),
    sessionFactory: async () => session,
    thinkingLevel: "medium",
  });
}

function createSession(
  overrides: Partial<PiSubAgentSession> = {},
): PiSubAgentSession {
  return {
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read", "grep", "find", "ls"]),
    getSessionStats: vi.fn(() => ({
      assistantMessages: 1,
      cost: 0.01,
      tokens: {
        cacheRead: 2,
        cacheWrite: 1,
        input: 20,
        output: 5,
        total: 25,
      },
    })),
    isStreaming: false,
    model: { id: "test-model", provider: "test-provider" },
    prompt: vi.fn(async () => {}),
    state: {
      messages: [
        {
          content: [{ text: "Final finding.", type: "text" }],
          role: "assistant",
        },
      ],
    },
    ...overrides,
  };
}

function createModel(): NonNullable<ExtensionContext["model"]> {
  return {
    id: "test-model",
    provider: "test-provider",
  } as NonNullable<ExtensionContext["model"]>;
}

function createModelRegistry(): ExtensionContext["modelRegistry"] {
  return {} as ExtensionContext["modelRegistry"];
}

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    input,
    toolCallId: "child-call",
    toolName,
    type: "tool_call",
  } as ToolCallEvent;
}
