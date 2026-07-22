import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import bumblebeeExtension from "../src/extension.js";

describe("bumblebeeExtension", () => {
  it("registers runtime and permission boundaries in lifecycle order", async () => {
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
      "session_shutdown",
      "session_tree",
      "tool_call",
    ]);
    expect(handlers.get("session_start")).toHaveLength(2);
    expect(handlers.get("session_shutdown")).toHaveLength(2);
    expect(handlers.get("session_tree")).toHaveLength(1);
    expect(handlers.get("tool_call")).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("delegate_task");

    const context = {
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
});
