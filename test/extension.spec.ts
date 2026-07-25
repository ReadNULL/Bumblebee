import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import bumblebeeExtension from "../src/extension.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bumblebeeExtension", () => {
  it("registers all full-profile boundaries in lifecycle order", async () => {
    vi.stubEnv("BUMBLEBEE_FEISHU_ENABLED", "false");
    vi.stubEnv(
      "BUMBLEBEE_MEMORY_DIR",
      path.resolve("virtual-memory"),
    );
    const handlers = new Map<string, unknown[]>();
    const tools: Array<{ name?: string }> = [];
    const api = new Proxy({} as ExtensionAPI, {
      get(_target, property) {
        if (property === "on") {
          return (event: string, handler: unknown) => {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
          };
        }
        if (property === "registerTool") {
          return (tool: { name?: string }) => tools.push(tool);
        }

        throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
      },
    });

    expect(bumblebeeExtension(api)).toBeUndefined();
    expect([...handlers.keys()]).toEqual([
      "session_start",
      "model_select",
      "session_shutdown",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "agent_end",
      "session_tree",
    ]);
    expect(handlers.get("session_start")).toHaveLength(2);
    expect(handlers.get("session_shutdown")).toHaveLength(3);
    expect(handlers.get("model_select")).toHaveLength(1);
    expect(handlers.get("before_agent_start")).toHaveLength(2);
    expect(handlers.get("tool_call")).toHaveLength(2);
    expect(handlers.get("tool_result")).toHaveLength(1);
    expect(handlers.get("agent_end")).toHaveLength(1);
    expect(handlers.get("session_tree")).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual([
      "bumblebee_memory",
      "delegate_task",
    ]);

    const context = {
      cwd: path.resolve("."),
      hasUI: false,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-1",
      },
    } as unknown as ExtensionContext;
    const starts = handlers.get("session_start") as
      | ExtensionHandler<SessionStartEvent>[]
      | undefined;
    const shutdowns = handlers.get("session_shutdown") as
      | ExtensionHandler<SessionShutdownEvent>[]
      | undefined;

    for (const start of starts ?? []) {
      await start({ reason: "startup", type: "session_start" }, context);
    }
    for (const shutdown of shutdowns ?? []) {
      await shutdown({ reason: "quit", type: "session_shutdown" }, context);
    }
  });

  it("registers no Bumblebee capabilities in pi-baseline profile", () => {
    const api = new Proxy({} as ExtensionAPI, {
      get(_target, property) {
        throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
      },
    });

    expect(() =>
      registerWithProfile(api, "pi-baseline"),
    ).not.toThrow();
  });

  it("keeps only assurance and permission in permission-only profile", () => {
    const handlers = new Map<string, unknown[]>();
    const tools: Array<{ name?: string }> = [];
    const api = new Proxy({} as ExtensionAPI, {
      get(_target, property) {
        if (property === "on") {
          return (event: string, handler: unknown) => {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
          };
        }
        if (property === "registerTool") {
          return (tool: { name?: string }) => tools.push(tool);
        }

        throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
      },
    });

    registerWithProfile(api, "permission-only");

    expect([...handlers.keys()]).toEqual([
      "session_start",
      "model_select",
      "session_shutdown",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "agent_end",
      "session_tree",
    ]);
    expect(handlers.get("session_start")).toHaveLength(2);
    expect(handlers.get("session_shutdown")).toHaveLength(3);
    expect(handlers.get("before_agent_start")).toHaveLength(1);
    expect(handlers.get("tool_call")).toHaveLength(2);
    expect(handlers.get("session_tree")).toHaveLength(2);
    expect(tools).toEqual([]);
  });
});

function registerWithProfile(
  pi: ExtensionAPI,
  profile: "pi-baseline" | "permission-only",
): void {
  vi.stubEnv("BUMBLEBEE_FEISHU_ENABLED", "false");
  vi.stubEnv(
    "BUMBLEBEE_MEMORY_DIR",
    path.resolve("virtual-memory"),
  );
  vi.stubEnv("BUMBLEBEE_FEATURE_PROFILE", profile);
  bumblebeeExtension(pi);
}
