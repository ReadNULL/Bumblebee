import { describe, expect, it, vi } from "vitest";

import {
  type ChannelAdapterStartContext,
  type ChannelDispatchResult,
  type ChannelMessageHandler,
  FeishuAdapter,
  type FeishuDiagnosticLogger,
  type FeishuEventHandler,
  type FeishuGateway,
  type FeishuReplyRequest,
} from "../../../src/channels/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
  getAbortError,
} from "../../../src/foundation/index.js";

describe("FeishuAdapter", () => {
  it("accepts any non-empty ReadonlySet sender allowlist", async () => {
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway, {
      allowedSenderIds: new ReadonlySenderIds(["ou_sender"]),
    });

    await adapter.start(createStartContext());
    gateway.emit(createEvent());

    await adapter.stop();
    expect(gateway.start).toHaveBeenCalledOnce();
  });

  it("acknowledges the SDK event before waiting for Agent processing", async () => {
    let finishMessage:
      | ((result: ChannelDispatchResult) => void)
      | undefined;
    const onMessage = vi.fn(
      () => new Promise<ChannelDispatchResult>((resolve) => {
        finishMessage = resolve;
      }),
    );
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway);
    await adapter.start(createStartContext(onMessage));

    gateway.emit(createEvent());
    expect(onMessage).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(gateway.reply).not.toHaveBeenCalled();
    finishMessage?.(deliveredResult());
    await Promise.resolve();

    await adapter.stop();
    expect(gateway.stop).toHaveBeenCalledOnce();
  });

  it("ignores unsupported, malformed, and unauthorized events", async () => {
    const onMessage = vi.fn(async () => deliveredResult());
    const logger = createLogger();
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway, {
      allowedSenderIds: new Set(["ou_owner"]),
      logger,
    });
    await adapter.start(createStartContext(onMessage));

    gateway.emit(createEvent({
      sender: { sender_id: { open_id: "ou_outsider" } },
    }));
    gateway.emit(createEvent({
      message: { message_type: "image" },
    }));
    gateway.emit(createEvent({
      message: { content: "invalid-json" },
    }));
    await Promise.resolve();

    expect(onMessage).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    await adapter.stop();
  });

  it("maps replies to a stable Feishu idempotency request", async () => {
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway);
    await adapter.start(createStartContext());
    const signal = new AbortController().signal;
    const reply = {
      channel: "feishu",
      conversationId: "oc_chat",
      inReplyToMessageId: "om_message",
      text: "result",
    };

    await adapter.send(reply, signal);
    await adapter.send(reply, signal);

    const first = gateway.reply.mock.calls[0]?.[0] as
      | FeishuReplyRequest
      | undefined;
    const second = gateway.reply.mock.calls[1]?.[0] as
      | FeishuReplyRequest
      | undefined;
    expect(first).toMatchObject({
      messageId: "om_message",
      text: "result",
    });
    expect(first?.requestId).toMatch(/^bb_[a-f0-9]{32}$/u);
    expect(second?.requestId).toBe(first?.requestId);
    await adapter.stop();
  });

  it("sends only an approved user-facing error when dispatch fails", async () => {
    const onMessage = vi.fn(async () => {
      throw new BumblebeeError("provider leaked internal detail", {
        code: ERROR_CODES.UNAVAILABLE,
        userMessage: "当前模型暂时不可用。",
      });
    });
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway);
    await adapter.start(createStartContext(onMessage));

    gateway.emit(createEvent());
    await vi.waitFor(() => expect(gateway.reply).toHaveBeenCalledOnce());

    expect(gateway.reply.mock.calls[0]?.[0]).toMatchObject({
      messageId: "om_message",
      text: "当前模型暂时不可用。",
    });
    await adapter.stop();
  });

  it("does not send fallback messages for shutdown cancellation", async () => {
    const onMessage = vi.fn(async () => {
      throw new BumblebeeError("shutdown", {
        code: ERROR_CODES.CANCELLED,
      });
    });
    const gateway = createGateway();
    const adapter = createAdapter(gateway.gateway);
    await adapter.start(createStartContext(onMessage));

    gateway.emit(createEvent());
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(gateway.reply).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it("rolls back a failed start and keeps stop idempotent", async () => {
    const failure = new Error("connection rejected");
    const gateway = createGateway({
      start: async () => {
        throw failure;
      },
    });
    const adapter = createAdapter(gateway.gateway);

    await expect(
      adapter.start(createStartContext()),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });
    await adapter.stop();
    expect(gateway.stop).toHaveBeenCalledOnce();
  });

  it("times out startup and propagates cancellation to the gateway", async () => {
    const gateway = createGateway({
      start: async (_handler, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(getAbortError(signal)),
            { once: true },
          );
        }),
    });
    const adapter = createAdapter(gateway.gateway, {
      startupTimeoutMs: 10,
    });

    await expect(
      adapter.start(createStartContext()),
    ).rejects.toMatchObject({ code: ERROR_CODES.TIMEOUT });
    expect(gateway.stop).toHaveBeenCalledOnce();
  });
});

interface GatewayOverrides {
  readonly start?: (
    handler: FeishuEventHandler,
    signal: AbortSignal,
  ) => Promise<void>;
}

class ReadonlySenderIds implements ReadonlySet<string> {
  private readonly inner: Set<string>;

  constructor(values: readonly string[]) {
    this.inner = new Set(values);
  }

  get size(): number {
    return this.inner.size;
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.inner[Symbol.iterator]();
  }

  entries(): SetIterator<[string, string]> {
    return this.inner.entries();
  }

  forEach(
    callback: (
      value: string,
      value2: string,
      set: ReadonlySet<string>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.inner) {
      callback.call(thisArg, value, value, this);
    }
  }

  has(value: string): boolean {
    return this.inner.has(value);
  }

  keys(): SetIterator<string> {
    return this.inner.keys();
  }

  values(): SetIterator<string> {
    return this.inner.values();
  }

  readonly [Symbol.toStringTag] = "ReadonlySenderIds";
}

interface GatewayControl {
  readonly emit: (event: unknown) => void;
  readonly gateway: FeishuGateway;
  readonly reply: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

function createGateway(
  overrides: GatewayOverrides = {},
): GatewayControl {
  let eventHandler: FeishuEventHandler | undefined;
  const reply = vi.fn(async (
    _request: FeishuReplyRequest,
    _signal: AbortSignal,
  ) => {});
  const start = vi.fn(async (
    handler: FeishuEventHandler,
    signal: AbortSignal,
  ) => {
    eventHandler = handler;
    await overrides.start?.(handler, signal);
  });
  const stop = vi.fn(async () => {});
  return {
    emit(event) {
      if (eventHandler === undefined) {
        throw new Error("gateway has not started");
      }
      eventHandler(event);
    },
    gateway: { reply, start, stop },
    reply,
    start,
    stop,
  };
}

function createAdapter(
  gateway: FeishuGateway,
  options: Partial<{
    allowedSenderIds: ReadonlySet<string> | "*";
    logger: FeishuDiagnosticLogger;
    startupTimeoutMs: number;
  }> = {},
): FeishuAdapter {
  return new FeishuAdapter({
    allowedSenderIds:
      options.allowedSenderIds ?? new Set(["ou_sender"]),
    gateway,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
  });
}

function createStartContext(
  onMessage: ChannelMessageHandler =
    vi.fn(async () => deliveredResult()),
): ChannelAdapterStartContext {
  return {
    onMessage,
    signal: new AbortController().signal,
  };
}

function deliveredResult(): ChannelDispatchResult {
  return {
    channel: "feishu",
    messageId: "om_message",
    status: "delivered",
  };
}

function createLogger(): FeishuDiagnosticLogger & {
  readonly debug: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createEvent(
  overrides: {
    readonly message?: Readonly<Record<string, unknown>>;
    readonly sender?: Readonly<Record<string, unknown>>;
  } = {},
): unknown {
  return {
    message: {
      chat_id: "oc_chat",
      chat_type: "p2p",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1721000000000",
      message_id: "om_message",
      message_type: "text",
      ...overrides.message,
    },
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
      ...overrides.sender,
    },
  };
}
