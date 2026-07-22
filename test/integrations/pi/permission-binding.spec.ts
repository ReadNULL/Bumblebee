import path from "node:path";

import type {
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  StructuredLogger,
  TraceContext,
  type LogRecord,
} from "../../../src/foundation/index.js";
import {
  bindPiPermissionSystem,
  type PermissionExecutionRuntime,
  type PiPermissionRegistrar,
} from "../../../src/integrations/pi/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../../src/runtime/index.js";
import {
  PERMISSION_MODES,
  PermissionSystem,
} from "../../../src/security/index.js";

interface CapturedHandlers {
  shutdown?: ExtensionHandler<SessionShutdownEvent>;
  start?: ExtensionHandler<SessionStartEvent>;
  tree?: ExtensionHandler<SessionTreeEvent>;
  toolCall?: ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
}

interface TestCustomEntry {
  customType: string;
  data?: unknown;
  type: "custom";
}

class ImmediateRuntime implements PermissionExecutionRuntime {
  readonly requests: TaskExecutionRequest[] = [];

  constructor(private readonly logger: StructuredLogger) {}

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

describe("bindPiPermissionSystem", () => {
  it("asks before a write and forwards execution metadata to the runtime", async () => {
    const fixture = createFixture("仅允许本次");
    const event = toolCall("write", { path: "src/index.ts" }, "call-1");

    const result = await fixture.handlers.toolCall?.(event, fixture.context);

    expect(result).toEqual({});
    expect(fixture.select).toHaveBeenCalledOnce();
    expect(fixture.select.mock.calls[0]?.[0]).toContain("写入路径(-w-)");
    expect(fixture.select.mock.calls[0]?.[0]).toContain("文件夹范围");
    expect(fixture.select.mock.calls[0]?.[1]).toEqual([
      "仅允许本次",
      "本会话允许相同操作",
      "对此文件夹下均允许该操作",
      "拒绝",
    ]);
    expect(fixture.select.mock.calls[0]?.[2]).toMatchObject({
      timeout: 60_000,
    });
    expect(fixture.runtime.requests[0]).toMatchObject({
      operationName: "permission.authorize",
      sessionKey: "pi:session-1",
      traceId: "call-1",
    });
  });

  it("blocks ask decisions in headless mode", async () => {
    const fixture = createFixture("仅允许本次", false);

    const result = await fixture.handlers.toolCall?.(
      toolCall("deploy", { environment: "prod" }),
      fixture.context,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("没有可用的授权界面");
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it("does not offer a broad session grant for an opaque custom tool", async () => {
    const fixture = createFixture("仅允许本次");

    await fixture.handlers.toolCall?.(
      toolCall("deploy", { environment: "prod" }),
      fixture.context,
    );

    expect(fixture.select.mock.calls[0]?.[1]).toEqual([
      "仅允许本次",
      "拒绝",
    ]);
  });

  it("restores exact grants when the same pi session is resumed", async () => {
    const branchEntries: TestCustomEntry[] = [];
    const fixture = createFixture(
      "本会话允许相同操作",
      true,
      "session-1",
      branchEntries,
    );
    const event = toolCall("bash", { command: "git status" });

    await fixture.handlers.toolCall?.(event, fixture.context);
    expect(fixture.appendedEntries).toHaveLength(1);
    expect(fixture.appendedEntries[0]).toMatchObject({
      customType: "bumblebee.permission-grant.v1",
      data: {
        grants: [
          { mode: PERMISSION_MODES.EXECUTE },
          { mode: PERMISSION_MODES.EXECUTE },
        ],
        version: 1,
      },
    });
    expect(JSON.stringify(fixture.appendedEntries)).not.toContain("git status");
    expect(fixture.select.mock.calls[0]?.[1]).not.toContain(
      "对此文件夹下均允许该操作",
    );

    const resumed = createFixture(
      "拒绝",
      true,
      "session-1",
      branchEntries,
    );
    await resumed.handlers.start?.(
      { reason: "resume", type: "session_start" },
      resumed.context,
    );
    const result = await resumed.handlers.toolCall?.(event, resumed.context);

    expect(result).toEqual({});
    expect(resumed.select).not.toHaveBeenCalled();
  });

  it("restores a folder wildcard and avoids prompts for descendants", async () => {
    const branchEntries: TestCustomEntry[] = [];
    const original = createFixture(
      "对此文件夹下均允许该操作",
      true,
      "session-1",
      branchEntries,
    );
    await original.handlers.toolCall?.(
      toolCall("write", { path: "src/index.ts" }),
      original.context,
    );

    const resumed = createFixture(
      "仅允许本次",
      true,
      "session-1",
      branchEntries,
    );
    await resumed.handlers.start?.(
      { reason: "resume", type: "session_start" },
      resumed.context,
    );
    await resumed.handlers.toolCall?.(
      toolCall("write", { path: "src/nested/other.ts" }),
      resumed.context,
    );
    await resumed.handlers.toolCall?.(
      toolCall("write", { path: "outside.ts" }),
      resumed.context,
    );

    expect(resumed.select).toHaveBeenCalledOnce();
    expect(JSON.stringify(branchEntries)).toContain("/**");
  });

  it("does not inherit copied grants when a fork has a new session id", async () => {
    const branchEntries: TestCustomEntry[] = [];
    const original = createFixture(
      "本会话允许相同操作",
      true,
      "session-1",
      branchEntries,
    );
    const event = toolCall("bash", { command: "git status" });
    await original.handlers.toolCall?.(event, original.context);

    const forked = createFixture(
      "仅允许本次",
      true,
      "session-2",
      branchEntries,
    );
    await forked.handlers.start?.(
      { reason: "fork", type: "session_start" },
      forked.context,
    );
    await forked.handlers.toolCall?.(event, forked.context);

    expect(forked.select).toHaveBeenCalledOnce();
  });

  it("rebuilds grants from the active tree branch", async () => {
    const branchEntries: TestCustomEntry[] = [];
    const fixture = createFixture(
      "本会话允许相同操作",
      true,
      "session-1",
      branchEntries,
    );
    const event = toolCall("bash", { command: "git status" });
    await fixture.handlers.toolCall?.(event, fixture.context);
    await fixture.handlers.toolCall?.(event, fixture.context);
    expect(fixture.select).toHaveBeenCalledTimes(1);

    branchEntries.length = 0;
    await fixture.handlers.tree?.(
      {
        newLeafId: "before-grant",
        oldLeafId: "after-grant",
        type: "session_tree",
      },
      fixture.context,
    );
    await fixture.handlers.toolCall?.(event, fixture.context);

    expect(fixture.select).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupted persisted grant and warns the user", async () => {
    const branchEntries: TestCustomEntry[] = [];
    const original = createFixture(
      "本会话允许相同操作",
      true,
      "session-1",
      branchEntries,
    );
    const event = toolCall("bash", { command: "git status" });
    await original.handlers.toolCall?.(event, original.context);
    const persisted = branchEntries[0];
    if (persisted === undefined) {
      throw new Error("expected a persisted permission entry");
    }
    persisted.data = {
      grants: [
        {
          caseSensitive: true,
          fingerprint: "0".repeat(64),
          match: "fingerprint",
          mode: 8,
          surface: "command",
        },
      ],
      sessionId: "session-1",
      version: 1,
    };

    const resumed = createFixture(
      "仅允许本次",
      true,
      "session-1",
      branchEntries,
    );
    await resumed.handlers.start?.(
      { reason: "resume", type: "session_start" },
      resumed.context,
    );
    await resumed.handlers.toolCall?.(event, resumed.context);

    expect(resumed.notify).toHaveBeenCalledWith(
      expect.stringContaining("授权记录无效"),
      "warning",
    );
    expect(resumed.select).toHaveBeenCalledOnce();
  });

  it("rolls back the in-memory grant when session persistence fails", async () => {
    const fixture = createFixture(
      "本会话允许相同操作",
      true,
      "session-1",
      [],
      new Error("session storage unavailable"),
    );
    const event = toolCall("bash", { command: "git status" });

    const first = await fixture.handlers.toolCall?.(event, fixture.context);
    const second = await fixture.handlers.toolCall?.(event, fixture.context);

    expect(first).toMatchObject({ block: true });
    expect(second).toMatchObject({ block: true });
    expect(fixture.select).toHaveBeenCalledTimes(2);
  });

  it("records policy metadata without logging raw command input", async () => {
    const fixture = createFixture("仅允许本次");
    const secretCommand = "echo permission-audit-secret";

    await fixture.handlers.toolCall?.(
      toolCall("bash", { command: secretCommand }),
      fixture.context,
    );

    const serializedLogs = JSON.stringify(fixture.records);
    expect(serializedLogs).toContain("permission evaluated");
    expect(serializedLogs).toContain("call-1");
    expect(serializedLogs).not.toContain(secretCommand);
  });

  it("fails closed when the runtime or permission boundary throws", async () => {
    const handlers: CapturedHandlers = {};
    const registrar = createRegistrar(handlers, [], []);
    const runtime: PermissionExecutionRuntime = {
      async execute<T>(): Promise<T> {
        throw new Error("internal path must not leak");
      },
    };
    bindPiPermissionSystem(registrar, runtime, createPermissionSystem());

    const { context } = createContext("仅允许本次", true);
    const result = await handlers.toolCall?.(
      toolCall("read", { path: "README.md" }),
      context,
    );

    expect(result).toEqual({
      block: true,
      reason: "权限检查失败，已阻止该工具调用。",
    });
  });
});

function createFixture(
  selected: string | undefined,
  hasUI = true,
  sessionId = "session-1",
  branchEntries: TestCustomEntry[] = [],
  appendFailure?: Error,
) {
  const handlers: CapturedHandlers = {};
  const appendedEntries: TestCustomEntry[] = [];
  const records: LogRecord[] = [];
  const traceContext = new TraceContext();
  const logger = new StructuredLogger({
    clock: () => new Date("2026-07-22T00:00:00.000Z"),
    sink: (record) => records.push(record),
    traceContext,
  });
  const runtime = new ImmediateRuntime(logger);
  const { context, notify, select } = createContext(
    selected,
    hasUI,
    sessionId,
    branchEntries,
  );

  bindPiPermissionSystem(
    createRegistrar(
      handlers,
      branchEntries,
      appendedEntries,
      appendFailure,
    ),
    runtime,
    createPermissionSystem(),
  );

  return {
    appendedEntries,
    context,
    handlers,
    notify,
    records,
    runtime,
    select,
  };
}

function createPermissionSystem(): PermissionSystem {
  return new PermissionSystem({
    pathNormalizer: { realpath: async (value) => value },
  });
}

function createRegistrar(
  handlers: CapturedHandlers,
  branchEntries: TestCustomEntry[],
  appendedEntries: TestCustomEntry[],
  appendFailure?: Error,
): PiPermissionRegistrar {
  return {
    appendEntry(customType: string, data?: unknown) {
      if (appendFailure !== undefined) {
        throw appendFailure;
      }

      const entry: TestCustomEntry = {
        customType,
        ...(data === undefined ? {} : { data }),
        type: "custom",
      };
      branchEntries.push(entry);
      appendedEntries.push(entry);
    },
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        handlers.start = handler as ExtensionHandler<SessionStartEvent>;
      } else if (event === "session_shutdown") {
        handlers.shutdown = handler as ExtensionHandler<SessionShutdownEvent>;
      } else if (event === "session_tree") {
        handlers.tree = handler as ExtensionHandler<SessionTreeEvent>;
      } else if (event === "tool_call") {
        handlers.toolCall = handler as ExtensionHandler<
          ToolCallEvent,
          ToolCallEventResult
        >;
      }
    },
  } as PiPermissionRegistrar;
}

function createContext(
  selected: string | undefined,
  hasUI: boolean,
  sessionId = "session-1",
  branchEntries: TestCustomEntry[] = [],
) {
  const select = vi.fn(
    async (
      _title: string,
      _options: string[],
      _dialogOptions?: { signal?: AbortSignal; timeout?: number },
    ) => selected,
  );
  const notify = vi.fn();
  const context = {
    cwd: path.resolve("virtual-workspace"),
    hasUI,
    sessionManager: {
      getBranch: () => branchEntries,
      getSessionId: () => sessionId,
    },
    signal: undefined,
    ui: { notify, select },
  } as unknown as ExtensionContext;

  return { context, notify, select };
}

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "call-1",
): ToolCallEvent {
  return {
    input,
    toolCallId,
    toolName,
    type: "tool_call",
  } as ToolCallEvent;
}
