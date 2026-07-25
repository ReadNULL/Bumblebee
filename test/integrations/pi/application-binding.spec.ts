import path from "node:path";

import type {
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type {
  FeishuEventHandler,
  FeishuGateway,
} from "../../../src/channels/index.js";
import {
  bindPiApplicationLifecycle,
  type ManagedConversationBridge,
  type PiApplicationRegistrar,
  type PiApplicationRuntime,
  type PiConversationBridgeOptions,
  type PiModelSelectEvent,
} from "../../../src/integrations/pi/index.js";
import type {
  ManagedMemory,
} from "../../../src/memory/index.js";

describe("bindPiApplicationLifecycle", () => {
  it("keeps the default extension network-free when Feishu is disabled", async () => {
    const calls: string[] = [];
    const runtime = createRuntime(calls);
    const captured = createRegistrar();
    bindPiApplicationLifecycle(captured.registrar, runtime, {
      environment: {},
    });

    await captured.start?.(
      { reason: "startup", type: "session_start" },
      createContext(),
    );
    await captured.shutdown?.(
      { reason: "quit", type: "session_shutdown" },
      createContext(),
    );

    expect(calls).toEqual(["runtime.initialize", "runtime.dispose"]);
  });

  it("starts channels after runtime and closes them in reverse order", async () => {
    const calls: string[] = [];
    const gateway = createGateway(calls);
    const bridge: ManagedConversationBridge = {
      async dispose() {
        calls.push("bridge.dispose");
      },
      async respond() {
        return { text: "ok" };
      },
    };
    let capturedBridgeOptions: PiConversationBridgeOptions | undefined;
    const captured = createRegistrar();
    const context = createContext(true, calls);
    const memory = createMemory(calls);

    bindPiApplicationLifecycle(
      captured.registrar,
      createRuntime(calls),
      {
        bridgeFactory: (options) => {
          capturedBridgeOptions = options;
          return bridge;
        },
        environment: enabledEnvironment(),
        feishuGatewayFactory: () => gateway,
        memory,
      },
    );

    await captured.start?.(
      { reason: "startup", type: "session_start" },
      context,
    );
    expect(calls).toEqual([
      "runtime.initialize",
      "memory.initialize",
      "gateway.start",
      "ui.notify:飞书渠道已连接。",
    ]);
    expect(capturedBridgeOptions?.memoryContextProvider).toBe(memory);

    const nextModel = createModel("model-b");
    await captured.modelSelect?.(
      { model: nextModel, type: "model_select" },
      context,
    );
    expect(capturedBridgeOptions?.getModel()).toBe(nextModel);

    await captured.shutdown?.(
      { reason: "quit", type: "session_shutdown" },
      context,
    );
    expect(calls.slice(-4)).toEqual([
      "gateway.stop",
      "bridge.dispose",
      "memory.dispose",
      "runtime.dispose",
    ]);
  });

  it("rolls runtime back when enabled channel configuration is invalid", async () => {
    const calls: string[] = [];
    const captured = createRegistrar();
    bindPiApplicationLifecycle(
      captured.registrar,
      createRuntime(calls),
      {
        environment: {
          BUMBLEBEE_FEISHU_ENABLED: "true",
          FEISHU_APP_ID: "cli_0123456789abcdef",
        },
      },
    );

    await expect(
      captured.start?.(
        { reason: "startup", type: "session_start" },
        createContext(),
      ),
    ).rejects.toBeDefined();
    expect(calls).toEqual(["runtime.initialize", "runtime.dispose"]);
  });
});

interface CapturedHandlers {
  readonly registrar: PiApplicationRegistrar;
  modelSelect?: ExtensionHandler<PiModelSelectEvent>;
  shutdown?: ExtensionHandler<SessionShutdownEvent>;
  start?: ExtensionHandler<SessionStartEvent>;
}

function createRegistrar(): CapturedHandlers {
  const captured = {} as CapturedHandlers;
  const registrar = {
    getThinkingLevel: () => "medium" as const,
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        captured.start = handler as ExtensionHandler<SessionStartEvent>;
      } else if (event === "session_shutdown") {
        captured.shutdown =
          handler as ExtensionHandler<SessionShutdownEvent>;
      } else if (event === "model_select") {
        captured.modelSelect =
          handler as ExtensionHandler<PiModelSelectEvent>;
      }
    },
  } as PiApplicationRegistrar;
  Object.defineProperty(captured, "registrar", {
    enumerable: true,
    value: registrar,
  });
  return captured;
}

function createRuntime(calls: string[]): PiApplicationRuntime {
  return {
    async dispose() {
      calls.push("runtime.dispose");
    },
    async execute() {
      throw new Error("not used by this lifecycle test");
    },
    async initialize() {
      calls.push("runtime.initialize");
    },
  };
}

function createGateway(calls: string[]): FeishuGateway {
  return {
    async reply() {},
    async start(_nextHandler: FeishuEventHandler) {
      calls.push("gateway.start");
    },
    async stop() {
      calls.push("gateway.stop");
    },
  };
}

function createMemory(calls: string[]): ManagedMemory {
  return {
    async buildPromptContext() {
      return "<memory-policy>test</memory-policy>";
    },
    async dispose() {
      calls.push("memory.dispose");
    },
    async initialize() {
      calls.push("memory.initialize");
    },
  };
}

function createContext(
  hasUI = false,
  calls?: string[],
): ExtensionContext {
  return {
    cwd: path.resolve("virtual-workspace"),
    hasUI,
    model: createModel("model-a"),
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    ui: {
      notify(message: string) {
        calls?.push(`ui.notify:${message}`);
      },
    },
  } as unknown as ExtensionContext;
}

function enabledEnvironment() {
  return {
    BUMBLEBEE_FEISHU_ENABLED: "true",
    FEISHU_ALLOWED_OPEN_IDS: "ou_owner",
    FEISHU_APP_ID: "cli_0123456789abcdef",
    FEISHU_APP_SECRET: "secret",
  };
}

function createModel(id: string): NonNullable<ExtensionContext["model"]> {
  return {
    id,
    provider: "test-provider",
  } as NonNullable<ExtensionContext["model"]>;
}
