import path from "node:path";

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
  StructuredLogger,
  TraceContext,
} from "../../../src/foundation/index.js";
import {
  bindPiMemory,
  createPiMemoryContextExtension,
  type PiMemoryRuntime,
} from "../../../src/integrations/pi/index.js";
import {
  MEMORY_TOOL_NAME,
  type MemoryRecord,
  type MemoryService,
} from "../../../src/memory/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../../src/runtime/index.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

class ImmediateRuntime implements PiMemoryRuntime {
  readonly requests: TaskExecutionRequest[] = [];
  private readonly logger = new StructuredLogger({
    clock: () => new Date("2026-07-23T00:00:00.000Z"),
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
      traceId: request.traceId ?? "memory-test",
    });
  }
}

describe("bindPiMemory", () => {
  it("registers one tool and appends selected memory before a turn", async () => {
    const runtime = new ImmediateRuntime();
    const memory = createMemory();
    vi.mocked(memory.buildPromptContext).mockResolvedValue(
      "<memory-policy>selected</memory-policy>",
    );
    const fixture = createRegistrar();
    const controller = new AbortController();

    bindPiMemory(fixture.pi, runtime, memory);

    expect(fixture.tool).toMatchObject({
      executionMode: "sequential",
      name: MEMORY_TOOL_NAME,
      parameters: {
        additionalProperties: false,
        required: ["action"],
        type: "object",
      },
    });
    const result = await fixture.beforeAgentStart?.(
      {
        prompt: "Which package manager?",
        systemPrompt: "base",
        systemPromptOptions: {},
        type: "before_agent_start",
      } as BeforeAgentStartEvent,
      createContext(controller.signal),
    );
    expect(result).toEqual({
      systemPrompt:
        "base\n\n<memory-policy>selected</memory-policy>",
    });
    expect(memory.buildPromptContext).toHaveBeenCalledWith(
      "Which package manager?",
      {
        access: "read-write",
        scope: "all",
        signal: controller.signal,
      },
    );
  });

  it("upserts through the runtime without logging memory content", async () => {
    const runtime = new ImmediateRuntime();
    const memory = createMemory();
    vi.mocked(memory.upsert).mockResolvedValue({
      record: createRecord(),
      status: "created",
    });
    const fixture = createRegistrar();
    bindPiMemory(fixture.pi, runtime, memory);

    const result = await requireTool(fixture).execute(
      "memory-call-1",
      {
        action: "upsert",
        category: "preference",
        content: "Use pnpm.",
        key: "package-manager",
        pinned: true,
        scope: "project",
      },
      undefined,
      undefined,
      createContext(),
    );

    expect(runtime.requests[0]).toMatchObject({
      operationName: "memory.upsert",
      sessionKey: "pi:session-1:memory",
      traceId: "memory-call-1",
    });
    expect(memory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Use pnpm.",
        key: "package-manager",
        scope: "project",
      }),
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      content: [{
        text: expect.stringContaining('"revision":1'),
        type: "text",
      }],
      details: {
        action: "upsert",
        recordCount: 1,
        status: "created",
      },
    });
  });

  it("returns bounded search results as untrusted reference data", async () => {
    const memory = createMemory();
    vi.mocked(memory.search).mockReturnValue([
      { record: createRecord(), score: 4.2 },
    ]);
    const fixture = createRegistrar();
    bindPiMemory(fixture.pi, new ImmediateRuntime(), memory);

    const result = await requireTool(fixture).execute(
      "memory-call-2",
      {
        action: "search",
        limit: 3,
        query: "dependency manager",
        scope: "all",
      },
      undefined,
      undefined,
      createContext(),
    );

    expect(memory.search).toHaveBeenCalledWith(
      "dependency manager",
      { limit: 3, scope: "all" },
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      content: [{
        text: expect.stringContaining(
          "untrusted historical reference data",
        ),
      }],
      details: { recordCount: 1 },
    });
  });

  it("exposes only approved memory errors and propagates cancellation", async () => {
    const memory = createMemory();
    vi.mocked(memory.upsert).mockRejectedValueOnce(
      new BumblebeeError("matched private key at internal offset", {
        code: ERROR_CODES.INVALID_INPUT,
        userMessage: "检测到疑似凭据。",
      }),
    );
    const fixture = createRegistrar();
    bindPiMemory(fixture.pi, new ImmediateRuntime(), memory);
    const tool = requireTool(fixture);
    const params = {
      action: "upsert",
      category: "fact",
      content: "redacted",
      key: "credential",
      scope: "global",
    };

    const failure = await tool.execute(
      "memory-call-3",
      params,
      undefined,
      undefined,
      createContext(),
    );
    expect(failure).toMatchObject({
      content: [{ text: "检测到疑似凭据。" }],
      isError: true,
    });
    expect(JSON.stringify(failure)).not.toContain("internal offset");

    const cancellation = new BumblebeeError("stop", {
      code: ERROR_CODES.CANCELLED,
    });
    vi.mocked(memory.upsert).mockRejectedValueOnce(cancellation);
    await expect(
      tool.execute(
        "memory-call-4",
        params,
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toBe(cancellation);
  });

  it("rejects action-specific extra fields before runtime scheduling", async () => {
    const runtime = new ImmediateRuntime();
    const fixture = createRegistrar();
    bindPiMemory(fixture.pi, runtime, createMemory());

    await expect(
      requireTool(fixture).execute(
        "memory-call-5",
        { action: "list", content: "unexpected" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("invalid action payload");
    expect(runtime.requests).toHaveLength(0);
  });

  it("builds a project-only context extension without registering tools", async () => {
    const memory = createMemory();
    vi.mocked(memory.buildPromptContext).mockResolvedValue(
      "<memory-policy>project</memory-policy>",
    );
    const on = vi.fn();
    const registerTool = vi.fn();
    const extension = createPiMemoryContextExtension(memory);

    extension({ on, registerTool } as unknown as ExtensionAPI);

    expect(on).toHaveBeenCalledWith(
      "before_agent_start",
      expect.any(Function),
    );
    expect(registerTool).not.toHaveBeenCalled();

    const handler = on.mock.calls[0]?.[1] as
      | ((
          event: BeforeAgentStartEvent,
          context: ExtensionContext,
        ) => Promise<unknown>)
      | undefined;
    await handler?.({
      prompt: "project decision",
      systemPrompt: "base",
      systemPromptOptions: {},
      type: "before_agent_start",
    } as BeforeAgentStartEvent, createContext());
    expect(memory.buildPromptContext).toHaveBeenCalledWith(
      "project decision",
      { access: "read-only", scope: "project" },
    );
  });
});

interface RegistrarFixture {
  beforeAgentStart?: ExtensionHandler<BeforeAgentStartEvent>;
  readonly pi: Pick<ExtensionAPI, "on" | "registerTool">;
  tool?: AnyToolDefinition;
}

function createRegistrar(): RegistrarFixture {
  const fixture = {} as RegistrarFixture;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "before_agent_start") {
        fixture.beforeAgentStart =
          handler as ExtensionHandler<BeforeAgentStartEvent>;
      }
    },
    registerTool(tool: unknown) {
      fixture.tool = tool as AnyToolDefinition;
    },
  } as unknown as Pick<ExtensionAPI, "on" | "registerTool">;
  Object.defineProperty(fixture, "pi", {
    enumerable: true,
    value: pi,
  });
  return fixture;
}

function requireTool(fixture: RegistrarFixture): AnyToolDefinition {
  if (fixture.tool === undefined) {
    throw new Error("expected memory tool to be registered");
  }
  return fixture.tool;
}

function createMemory(): MemoryService {
  return {
    buildPromptContext: vi.fn(async () => ""),
    dispose: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    list: vi.fn(() => []),
    remove: vi.fn(async () => ({
      record: createRecord(),
      status: "removed" as const,
    })),
    search: vi.fn(() => []),
    upsert: vi.fn(async () => ({
      record: createRecord(),
      status: "created" as const,
    })),
  };
}

function createRecord(): MemoryRecord {
  return Object.freeze({
    category: "preference",
    content: "Use pnpm.",
    createdAt: "2026-07-23T00:00:00.000Z",
    id: "mem_000000000000000000000001",
    key: "package-manager",
    keywords: Object.freeze(["dependencies"]),
    pinned: true,
    revision: 1,
    scope: "project",
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
}

function createContext(signal?: AbortSignal): ExtensionContext {
  return {
    cwd: path.resolve("virtual-workspace"),
    sessionManager: {
      getSessionId: () => "session-1",
    },
    ...(signal === undefined ? {} : { signal }),
  } as unknown as ExtensionContext;
}
