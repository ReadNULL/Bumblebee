import type {
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  bindPiLifecycle,
  type ManagedRuntime,
  type PiLifecycleRegistrar,
} from "../../../src/integrations/pi/index.js";

interface CapturedHandlers {
  shutdown?: ExtensionHandler<SessionShutdownEvent>;
  start?: ExtensionHandler<SessionStartEvent>;
}

function createRegistrar(handlers: CapturedHandlers): PiLifecycleRegistrar {
  return {
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        handlers.start = handler as ExtensionHandler<SessionStartEvent>;
      } else if (event === "session_shutdown") {
        handlers.shutdown = handler as ExtensionHandler<SessionShutdownEvent>;
      }
    },
  } as PiLifecycleRegistrar;
}

const context = {} as ExtensionContext;

describe("bindPiLifecycle", () => {
  it("maps pi session start and shutdown to one managed runtime", async () => {
    const calls: string[] = [];
    const handlers: CapturedHandlers = {};
    const runtime: ManagedRuntime = {
      async dispose() {
        calls.push("dispose");
      },
      async initialize() {
        calls.push("initialize");
      },
    };

    bindPiLifecycle(createRegistrar(handlers), runtime);

    await handlers.start?.(
      { reason: "startup", type: "session_start" },
      context,
    );
    await handlers.shutdown?.(
      { reason: "quit", type: "session_shutdown" },
      context,
    );

    expect(calls).toEqual(["initialize", "dispose"]);
  });

  it("does not hide runtime initialization failures from pi", async () => {
    const handlers: CapturedHandlers = {};
    const failure = new Error("runtime failed");
    const runtime: ManagedRuntime = {
      async dispose() {},
      async initialize() {
        throw failure;
      },
    };

    bindPiLifecycle(createRegistrar(handlers), runtime);

    await expect(
      handlers.start?.(
        { reason: "startup", type: "session_start" },
        context,
      ),
    ).rejects.toBe(failure);
  });
});
