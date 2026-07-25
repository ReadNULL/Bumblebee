import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  close: vi.fn(),
  dispatcherOptions: [] as unknown[],
  eventHandles: undefined as Record<string, (event: unknown) => unknown>
    | undefined,
  reply: vi.fn(),
  status: "connecting",
  wsOptions: undefined as Record<string, unknown> | undefined,
  wsStart: vi.fn(async () => {}),
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class Client {
    readonly im = {
      message: {
        reply: sdk.reply,
      },
    };

    constructor(options: unknown) {
      sdk.clientOptions.push(options);
    }
  }

  class EventDispatcher {
    constructor(options: unknown) {
      sdk.dispatcherOptions.push(options);
    }

    register(handles: Record<string, (event: unknown) => unknown>) {
      sdk.eventHandles = handles;
      return this;
    }
  }

  class WSClient {
    constructor(options: Record<string, unknown>) {
      sdk.wsOptions = options;
    }

    close = sdk.close;
    getConnectionStatus() {
      return { reconnectAttempts: 0, state: sdk.status };
    }
    start = sdk.wsStart;
  }

  return {
    Client,
    Domain: { Feishu: "feishu" },
    EventDispatcher,
    LoggerLevel: { error: 1 },
    WSClient,
  };
});

import type { FeishuConfig } from "../../../src/channels/index.js";
import { OfficialFeishuGateway } from "../../../src/channels/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

describe("OfficialFeishuGateway", () => {
  beforeEach(() => {
    sdk.clientOptions.length = 0;
    sdk.close.mockClear();
    sdk.dispatcherOptions.length = 0;
    sdk.eventHandles = undefined;
    sdk.reply.mockReset();
    sdk.reply.mockResolvedValue({ code: 0 });
    sdk.status = "connecting";
    sdk.wsOptions = undefined;
    sdk.wsStart.mockClear();
  });

  it("waits for onReady and registers a non-blocking receive_v1 handler", async () => {
    const received: unknown[] = [];
    const gateway = new OfficialFeishuGateway(createConfig());
    const start = gateway.start(
      (event) => received.push(event),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(sdk.wsStart).toHaveBeenCalledOnce());

    let completed = false;
    void start.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    sdk.status = "connected";
    getWsCallback("onReady")();
    await start;

    const event = { message: { message_id: "om_1" } };
    sdk.eventHandles?.["im.message.receive_v1"]?.(event);
    expect(received).toEqual([event]);
    expect(sdk.clientOptions[0]).toMatchObject({
      appId: "cli_0123456789abcdef",
      appSecret: "secret",
      loggerLevel: 1,
      source: "bumblebee",
    });
  });

  it("normalizes a rejected SDK startup as a retryable failure", async () => {
    sdk.wsStart.mockRejectedValueOnce(new Error("socket rejected"));
    const gateway = new OfficialFeishuGateway(createConfig());

    await expect(
      gateway.start(
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });
  });

  it("maps a text reply to the official API including the idempotency uuid", async () => {
    const gateway = new OfficialFeishuGateway(createConfig());

    await gateway.reply(
      {
        messageId: "om_message",
        requestId: "bb_request",
        text: "hello",
      },
      new AbortController().signal,
    );

    expect(sdk.reply).toHaveBeenCalledWith({
      data: {
        content: JSON.stringify({ text: "hello" }),
        msg_type: "text",
        uuid: "bb_request",
      },
      path: { message_id: "om_message" },
    });
  });

  it("rejects non-success API codes without exposing the SDK message", async () => {
    sdk.reply.mockResolvedValue({ code: 23_001, msg: "sensitive detail" });
    const gateway = new OfficialFeishuGateway(createConfig());

    await expect(
      gateway.reply(
        {
          messageId: "om_message",
          requestId: "bb_request",
          text: "hello",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      context: { apiCode: 23_001 },
    });
  });

  it("forces the socket closed and rejects a pending startup", async () => {
    const gateway = new OfficialFeishuGateway(createConfig());
    const start = gateway.start(
      () => {},
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(sdk.wsStart).toHaveBeenCalledOnce());

    await gateway.stop();

    await expect(start).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
    await gateway.stop();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it("shares a failed close result across repeated stop calls", async () => {
    const closeFailure = new Error("close failed");
    sdk.close.mockImplementationOnce(() => {
      throw closeFailure;
    });
    const gateway = new OfficialFeishuGateway(createConfig());

    await expect(gateway.stop()).rejects.toBe(closeFailure);
    await expect(gateway.stop()).rejects.toBe(closeFailure);
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});

function getWsCallback(name: string): () => void {
  const candidate = sdk.wsOptions?.[name];
  if (typeof candidate !== "function") {
    throw new Error(`missing WS callback: ${name}`);
  }
  return candidate as () => void;
}

function createConfig(): FeishuConfig {
  return {
    allowedSenderIds: new Set(["ou_owner"]),
    appId: "cli_0123456789abcdef",
    appSecret: "secret",
  };
}
