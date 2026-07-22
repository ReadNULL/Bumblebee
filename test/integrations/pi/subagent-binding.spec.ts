import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { SubAgentExecutor } from "../../../src/agents/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
  StructuredLogger,
  TraceContext,
} from "../../../src/foundation/index.js";
import {
  bindPiSubAgent,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DELEGATE_TASK_TOOL_NAME,
  type SubAgentExecutionRuntime,
} from "../../../src/integrations/pi/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../../src/runtime/index.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

class ImmediateRuntime implements SubAgentExecutionRuntime {
  readonly requests: TaskExecutionRequest[] = [];
  private readonly logger = new StructuredLogger({
    clock: () => new Date("2026-07-22T00:00:00.000Z"),
    sink: () => {},
    traceContext: new TraceContext(),
  });

  async execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T> {
    this.requests.push(request);
    return await operation({
      logger: this.logger,
      signal: request.signal ?? new AbortController().signal,
      traceId: request.traceId ?? "test-trace",
    });
  }
}

describe("bindPiSubAgent", () => {
  it("registers one bounded tool and executes it through the runtime", async () => {
    const runtime = new ImmediateRuntime();
    const executor: SubAgentExecutor = {
      execute: vi.fn(async () => ({
        model: "provider/model",
        output: "The entry point is src/extension.ts.",
        usage: { totalTokens: 42 },
      })),
    };
    const fixture = createRegistrar();
    const executorFactory = vi.fn(() => executor);

    bindPiSubAgent(fixture.pi, runtime, { executorFactory });
    const tool = requireTool(fixture);
    const result = await tool.execute(
      "call-1",
      { task: "Find the extension entry point" },
      undefined,
      undefined,
      createContext(),
    );

    expect(tool).toMatchObject({
      executionMode: "sequential",
      name: DELEGATE_TASK_TOOL_NAME,
      parameters: {
        additionalProperties: false,
        required: ["task"],
        type: "object",
      },
    });
    expect(runtime.requests[0]).toMatchObject({
      operationName: "subagent.delegate",
      sessionKey: "pi:session-1:subagent",
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      traceId: "call-1",
    });
    expect(executorFactory).toHaveBeenCalledWith(
      expect.anything(),
      "medium",
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Find the extension entry point",
      }),
    );
    expect(result).toMatchObject({
      content: [
        { text: "The entry point is src/extension.ts.", type: "text" },
      ],
      details: { status: "completed" },
    });
  });

  it("returns a structured timeout result without exposing internal errors", async () => {
    const fixture = createRegistrar();
    const runtime: SubAgentExecutionRuntime = {
      async execute<T>(): Promise<T> {
        throw new BumblebeeError("internal deadline details", {
          code: ERROR_CODES.TIMEOUT,
        });
      },
    };
    bindPiSubAgent(fixture.pi, runtime, {
      executorFactory: () => ({ execute: async () => ({ output: "unused" }) }),
      timeoutMs: 2_000,
    });

    const result = await requireTool(fixture).execute(
      "call-2",
      { task: "Inspect" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result).toMatchObject({
      content: [{ text: "子 Agent 在 2 秒内未完成。", type: "text" }],
      details: { status: "timed_out", timeoutMs: 2_000 },
    });
    expect(JSON.stringify(result)).not.toContain("internal deadline details");
  });

  it("propagates user cancellation instead of returning a normal tool result", async () => {
    const fixture = createRegistrar();
    const cancellation = new BumblebeeError("stop", {
      code: ERROR_CODES.CANCELLED,
    });
    const runtime: SubAgentExecutionRuntime = {
      async execute<T>(): Promise<T> {
        throw cancellation;
      },
    };
    bindPiSubAgent(fixture.pi, runtime, {
      executorFactory: () => ({ execute: async () => ({ output: "unused" }) }),
    });

    await expect(
      requireTool(fixture).execute(
        "call-3",
        { task: "Inspect" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toBe(cancellation);
  });

  it("rejects extra or empty tool arguments before scheduling work", async () => {
    const runtime = new ImmediateRuntime();
    const fixture = createRegistrar();
    bindPiSubAgent(fixture.pi, runtime, {
      executorFactory: () => ({ execute: async () => ({ output: "unused" }) }),
    });
    const tool = requireTool(fixture);

    await expect(
      tool.execute(
        "call-4",
        { extra: true, task: "Inspect" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("requires one task string");
    expect(runtime.requests).toHaveLength(0);
  });
});

function createRegistrar(): {
  readonly pi: Pick<ExtensionAPI, "getThinkingLevel" | "registerTool">;
  tool?: AnyToolDefinition;
} {
  const fixture: {
    pi: Pick<ExtensionAPI, "getThinkingLevel" | "registerTool">;
    tool?: AnyToolDefinition;
  } = {
    pi: undefined as unknown as Pick<
      ExtensionAPI,
      "getThinkingLevel" | "registerTool"
    >,
  };
  fixture.pi = {
    getThinkingLevel: () => "medium",
    registerTool: (tool: unknown) => {
      fixture.tool = tool as AnyToolDefinition;
    },
  } as unknown as Pick<ExtensionAPI, "getThinkingLevel" | "registerTool">;
  return fixture;
}

function requireTool(
  fixture: { readonly tool?: AnyToolDefinition },
): AnyToolDefinition {
  if (fixture.tool === undefined) {
    throw new Error("expected delegate_task to be registered");
  }
  return fixture.tool;
}

function createContext(): ExtensionContext {
  return {
    cwd: path.resolve("virtual-workspace"),
    model: {
      id: "test-model",
      provider: "test-provider",
    },
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "session-1",
    },
  } as unknown as ExtensionContext;
}
