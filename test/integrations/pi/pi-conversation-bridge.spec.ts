import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_CHANNEL_TEXT_LENGTH,
  type ChannelMessage,
} from "../../../src/channels/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/index.js";
import {
  PiConversationBridge,
  type PiConversationSession,
  type PiConversationSessionFactoryOptions,
} from "../../../src/integrations/pi/index.js";

describe("PiConversationBridge", () => {
  it("isolates conversations in stable hashed session directories", async () => {
    const sessionRoot = path.resolve("virtual-agent", "channel-sessions");
    const captures: PiConversationSessionFactoryOptions[] = [];
    const controls: ControlledSession[] = [];
    const sessionFactory = vi.fn(
      async (options: PiConversationSessionFactoryOptions) => {
        captures.push(options);
        const control = createControlledSession({
          initialMessages: [assistantMessage("old reply")],
          model: options.model,
          responseText: (text) => `reply:${text}`,
          thinkingLevel: options.thinkingLevel,
        });
        controls.push(control);
        return control.session;
      },
    );
    const bridge = createBridge({ sessionFactory, sessionRoot });

    await expect(
      bridge.respond(
        createMessage("tenant/private-room", "message-1", "first"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "reply:first" });
    await expect(
      bridge.respond(
        createMessage("tenant/private-room", "message-2", "second"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "reply:second" });
    await bridge.respond(
      createMessage("another-room", "message-3", "third"),
      new AbortController().signal,
    );

    expect(sessionFactory).toHaveBeenCalledTimes(2);
    const firstDirectory = captures[0]?.sessionDirectory;
    expect(firstDirectory).toBeDefined();
    expect(firstDirectory).not.toContain("tenant/private-room");
    expect(path.dirname(firstDirectory ?? "")).toBe(
      path.join(sessionRoot, "feishu"),
    );
    expect(path.basename(firstDirectory ?? "")).toMatch(/^[a-f0-9]{64}$/u);

    await bridge.dispose();
    expect(controls[0]?.dispose).toHaveBeenCalledOnce();
    expect(controls[1]?.dispose).toHaveBeenCalledOnce();

    let restoredDirectory = "";
    const restoredControl = createControlledSession();
    const restoredBridge = createBridge({
      sessionFactory: async (options) => {
        restoredDirectory = options.sessionDirectory;
        return restoredControl.session;
      },
      sessionRoot,
    });
    await restoredBridge.respond(
      createMessage("tenant/private-room", "message-4", "restored"),
      new AbortController().signal,
    );
    expect(restoredDirectory).toBe(firstDirectory);
    await restoredBridge.dispose();
  });

  it("shares one creation promise and rejects an overlapping same-session turn", async () => {
    let finishCreation: ((session: PiConversationSession) => void) | undefined;
    const creation = new Promise<PiConversationSession>((resolve) => {
      finishCreation = resolve;
    });
    const control = createControlledSession();
    const sessionFactory = vi.fn(async () => creation);
    const bridge = createBridge({ sessionFactory });

    const first = bridge.respond(
      createMessage("same-room", "message-1", "first"),
      new AbortController().signal,
    );
    const second = bridge.respond(
      createMessage("same-room", "message-2", "second"),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(sessionFactory).toHaveBeenCalledOnce());
    finishCreation?.(control.session);

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const rejection = outcomes.find((item) => item.status === "rejected");
    expect(rejection).toMatchObject({
      reason: { code: ERROR_CODES.CONFLICT },
    });
    expect(sessionFactory).toHaveBeenCalledOnce();
    await bridge.dispose();
  });

  it("removes a failed creation so the same conversation can retry", async () => {
    const control = createControlledSession();
    const sessionFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("temporary model failure");
      })
      .mockResolvedValueOnce(control.session);
    const bridge = createBridge({ sessionFactory });
    const message = createMessage("retry-room", "message-1", "hello");

    await expect(
      bridge.respond(message, new AbortController().signal),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });
    await expect(
      bridge.respond(
        { ...message, messageId: "message-2" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "reply:hello" });

    expect(sessionFactory).toHaveBeenCalledTimes(2);
    await bridge.dispose();
  });

  it("rejects an unsafe tool set and disposes the invalid session", async () => {
    const control = createControlledSession({
      toolNames: ["read", "grep", "find", "ls", "bash"],
    });
    const bridge = createBridge({
      sessionFactory: async () => control.session,
    });

    await expect(
      bridge.respond(
        createMessage("unsafe-room", "message-1", "inspect"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    expect(control.prompt).not.toHaveBeenCalled();
    expect(control.dispose).toHaveBeenCalledOnce();

    await bridge.dispose();
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("evicts only the least-recent idle session", async () => {
    const controls: ControlledSession[] = [];
    const bridge = createBridge({
      maxOpenSessions: 2,
      sessionFactory: async (options) => {
        const control = createControlledSession({
          model: options.model,
          thinkingLevel: options.thinkingLevel,
        });
        controls.push(control);
        return control.session;
      },
    });
    const signal = new AbortController().signal;

    await bridge.respond(createMessage("room-a", "a-1", "A"), signal);
    await bridge.respond(createMessage("room-b", "b-1", "B"), signal);
    await bridge.respond(createMessage("room-a", "a-2", "A again"), signal);
    await bridge.respond(createMessage("room-c", "c-1", "C"), signal);

    expect(controls).toHaveLength(3);
    expect(controls[0]?.dispose).not.toHaveBeenCalled();
    expect(controls[1]?.dispose).toHaveBeenCalledOnce();
    expect(controls[2]?.dispose).not.toHaveBeenCalled();

    await bridge.dispose();
    expect(controls[0]?.dispose).toHaveBeenCalledOnce();
    expect(controls[2]?.dispose).toHaveBeenCalledOnce();
  });

  it("returns a retryable error when capacity contains only active sessions", async () => {
    let finishPrompt: (() => void) | undefined;
    const control = createControlledSession({
      promptBehavior: async () =>
        new Promise<void>((resolve) => {
          finishPrompt = resolve;
        }),
    });
    const bridge = createBridge({
      maxOpenSessions: 1,
      sessionFactory: async () => control.session,
    });

    const active = bridge.respond(
      createMessage("active-room", "a-1", "wait"),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(control.prompt).toHaveBeenCalledOnce());

    await expect(
      bridge.respond(
        createMessage("other-room", "b-1", "other"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });

    finishPrompt?.();
    await active;
    await bridge.dispose();
  });

  it("syncs later pi model and thinking-level changes before prompting", async () => {
    let model = createModel("model-a");
    let thinkingLevel: "low" | "high" = "low";
    const control = createControlledSession({
      model,
      thinkingLevel,
    });
    const bridge = createBridge({
      getModel: () => model,
      getThinkingLevel: () => thinkingLevel,
      sessionFactory: async () => control.session,
    });
    const signal = new AbortController().signal;

    await bridge.respond(createMessage("model-room", "m-1", "first"), signal);
    expect(control.setModel).not.toHaveBeenCalled();
    expect(control.setThinkingLevel).not.toHaveBeenCalled();

    model = createModel("model-b");
    thinkingLevel = "high";
    await bridge.respond(createMessage("model-room", "m-2", "second"), signal);

    expect(control.setModel).toHaveBeenCalledWith(model);
    expect(control.setThinkingLevel).toHaveBeenCalledWith("high");
    await bridge.dispose();
  });

  it("bounds oversized model output before it reaches a channel adapter", async () => {
    const notice = "\n\n[回复过长，已截断]";
    const prefixLength = MAX_CHANNEL_TEXT_LENGTH - notice.length;
    const control = createControlledSession({
      responseText: () =>
        `${"x".repeat(prefixLength - 1)}😀${"z".repeat(100)}`,
    });
    const bridge = createBridge({
      sessionFactory: async () => control.session,
    });

    const response = await bridge.respond(
      createMessage("large-room", "l-1", "large"),
      new AbortController().signal,
    );

    expect(response.metadata).toEqual({ truncated: true });
    expect(response.text.length).toBeLessThanOrEqual(MAX_CHANNEL_TEXT_LENGTH);
    expect(response.text).toMatch(/\[回复过长，已截断\]$/u);
    expect(response.text).not.toContain("\uD83D");
    await bridge.dispose();
  });

  it("aborts a cancelled turn but retains the session for the next message", async () => {
    let finishFirstPrompt: (() => void) | undefined;
    let promptCount = 0;
    const control = createControlledSession({
      abortBehavior: async () => finishFirstPrompt?.(),
      promptBehavior: async () => {
        promptCount += 1;
        if (promptCount === 1) {
          await new Promise<void>((resolve) => {
            finishFirstPrompt = resolve;
          });
        }
      },
    });
    const bridge = createBridge({
      sessionFactory: async () => control.session,
    });
    const controller = new AbortController();

    const cancelled = bridge.respond(
      createMessage("cancel-room", "c-1", "first"),
      controller.signal,
    );
    await vi.waitFor(() => expect(control.prompt).toHaveBeenCalledOnce());
    controller.abort(
      new BumblebeeError("cancelled by channel", {
        code: ERROR_CODES.CANCELLED,
      }),
    );

    await expect(cancelled).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(control.abort).toHaveBeenCalledOnce();
    expect(control.dispose).not.toHaveBeenCalled();

    await expect(
      bridge.respond(
        createMessage("cancel-room", "c-2", "second"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "reply:second" });
    expect(control.abort).toHaveBeenCalledOnce();
    await bridge.dispose();
  });

  it("aborts active work during idempotent disposal and rejects new turns", async () => {
    let finishPrompt: (() => void) | undefined;
    const control = createControlledSession({
      abortBehavior: async () => finishPrompt?.(),
      promptBehavior: async () =>
        new Promise<void>((resolve) => {
          finishPrompt = resolve;
        }),
    });
    const bridge = createBridge({
      sessionFactory: async () => control.session,
    });
    const active = bridge.respond(
      createMessage("close-room", "d-1", "wait"),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(control.prompt).toHaveBeenCalledOnce());

    const firstDispose = bridge.dispose();
    const secondDispose = bridge.dispose();
    expect(secondDispose).toBe(firstDispose);

    await expect(active).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    await firstDispose;
    expect(control.abort).toHaveBeenCalledOnce();
    expect(control.dispose).toHaveBeenCalledOnce();

    await expect(
      bridge.respond(
        createMessage("close-room", "d-2", "after close"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
  });

  it("fails before session creation when pi has no selected model", async () => {
    const sessionFactory = vi.fn(async () => createControlledSession().session);
    const bridge = createBridge({
      getModel: () => undefined,
      sessionFactory,
    });

    await expect(
      bridge.respond(
        createMessage("model-room", "m-1", "hello"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAVAILABLE });
    expect(sessionFactory).not.toHaveBeenCalled();
    await bridge.dispose();
  });
});

interface ControlledSessionOptions {
  readonly abortBehavior?: () => Promise<void>;
  readonly initialMessages?: readonly unknown[];
  readonly model?: NonNullable<ExtensionContext["model"]>;
  readonly promptBehavior?: (
    text: string,
    messages: unknown[],
  ) => Promise<void>;
  readonly responseText?: (text: string) => string;
  readonly thinkingLevel?: PiConversationSession["thinkingLevel"];
  readonly toolNames?: readonly string[];
}

interface ControlledSession {
  readonly abort: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly messages: unknown[];
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly session: PiConversationSession;
  readonly setModel: ReturnType<typeof vi.fn>;
  readonly setThinkingLevel: ReturnType<typeof vi.fn>;
}

function createControlledSession(
  options: ControlledSessionOptions = {},
): ControlledSession {
  const messages = [...(options.initialMessages ?? [])];
  let currentModel = options.model ?? createModel("model-a");
  let currentThinkingLevel = options.thinkingLevel ?? "medium";
  let streaming = false;

  const abort = vi.fn(async () => {
    await options.abortBehavior?.();
  });
  const dispose = vi.fn();
  const prompt = vi.fn(async (text: string) => {
    streaming = true;
    messages.push({ content: text, role: "user" });
    try {
      await options.promptBehavior?.(text, messages);
      messages.push(
        assistantMessage(options.responseText?.(text) ?? `reply:${text}`),
      );
    } finally {
      streaming = false;
    }
  });
  const setModel = vi.fn(async (
    model: NonNullable<ExtensionContext["model"]>,
  ) => {
    currentModel = model;
  });
  const setThinkingLevel = vi.fn((
    level: PiConversationSession["thinkingLevel"],
  ) => {
    currentThinkingLevel = level;
  });

  const session: PiConversationSession = {
    abort,
    dispose,
    getActiveToolNames: vi.fn(() => [
      ...(options.toolNames ?? ["read", "grep", "find", "ls"]),
    ]),
    get isStreaming() {
      return streaming;
    },
    get model() {
      return currentModel;
    },
    prompt,
    setModel,
    setThinkingLevel,
    state: { messages },
    get thinkingLevel() {
      return currentThinkingLevel;
    },
  };
  return {
    abort,
    dispose,
    messages,
    prompt,
    session,
    setModel,
    setThinkingLevel,
  };
}

function createBridge(
  options: Partial<{
    getModel: () => ExtensionContext["model"];
    getThinkingLevel: () => PiConversationSession["thinkingLevel"];
    maxOpenSessions: number;
    sessionFactory: (
      options: PiConversationSessionFactoryOptions,
    ) => Promise<PiConversationSession>;
    sessionRoot: string;
  }> = {},
): PiConversationBridge {
  return new PiConversationBridge({
    agentDir: path.resolve("virtual-agent"),
    cwd: path.resolve("virtual-workspace"),
    getModel: options.getModel ?? (() => createModel("model-a")),
    getThinkingLevel: options.getThinkingLevel ?? (() => "medium"),
    ...(options.maxOpenSessions === undefined
      ? {}
      : { maxOpenSessions: options.maxOpenSessions }),
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    ...(options.sessionFactory === undefined
      ? {}
      : { sessionFactory: options.sessionFactory }),
    sessionRoot: options.sessionRoot ??
      path.resolve("virtual-agent", "channel-sessions"),
  });
}

function createMessage(
  conversationId: string,
  messageId: string,
  text: string,
): ChannelMessage {
  return {
    channel: "feishu",
    conversationId,
    messageId,
    senderId: "user-1",
    text,
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string): unknown {
  return {
    content: [{ text, type: "text" }],
    role: "assistant",
  };
}

function createModel(
  id: string,
): NonNullable<ExtensionContext["model"]> {
  return {
    id,
    provider: "test-provider",
  } as NonNullable<ExtensionContext["model"]>;
}
