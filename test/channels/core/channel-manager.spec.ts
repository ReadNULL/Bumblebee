import { describe, expect, it } from "vitest";

import {
  CHANNEL_DISPATCH_STATUSES,
  ChannelManager,
  type ChannelAdapter,
  type ChannelAdapterStartContext,
  type ChannelDispatchResult,
  type ChannelMessage,
  type ChannelMessageDispatcher,
  type ChannelReply,
} from "../../../src/channels/index.js";
import {
  ERROR_CODES,
  getAbortError,
  LIFECYCLE_STATES,
} from "../../../src/foundation/index.js";

describe("ChannelManager", () => {
  it("starts adapters and forwards messages to the dispatcher", async () => {
    const events: string[] = [];
    const adapter = new FakeAdapter("feishu", events);
    const dispatcher = new RecordingDispatcher();
    const manager = new ChannelManager({
      adapters: [adapter],
      dispatcher,
    });

    await manager.initialize();
    await expect(adapter.emit(createMessage())).resolves.toEqual({
      channel: "feishu",
      messageId: "message-1",
      status: CHANNEL_DISPATCH_STATUSES.NO_REPLY,
    });
    expect(dispatcher.messages).toHaveLength(1);
    expect(manager.status).toEqual({
      adapterIds: ["feishu"],
      inFlightMessageCount: 0,
      state: LIFECYCLE_STATES.READY,
    });

    await manager.dispose();
    expect(events).toEqual(["start:feishu", "stop:feishu"]);
  });

  it("stops adapters in reverse order and cancels in-flight dispatch", async () => {
    const events: string[] = [];
    const first = new FakeAdapter("feishu", events);
    const second = new FakeAdapter("dingtalk", events);
    const started = createDeferred<void>();
    const dispatcher: ChannelMessageDispatcher = {
      dispatch(_adapter, message, signal) {
        started.resolve();
        return new Promise<ChannelDispatchResult>((_resolve, reject) => {
          const onAbort = () => reject(
            getAbortError(signal as AbortSignal),
          );
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
          }
        }).then(() => ({
          channel: message.channel,
          messageId: message.messageId,
          status: CHANNEL_DISPATCH_STATUSES.NO_REPLY,
        }));
      },
    };
    const manager = new ChannelManager({
      adapters: [first, second],
      dispatcher,
    });
    await manager.initialize();

    const dispatch = first.emit(createMessage());
    await started.promise;
    expect(manager.status.inFlightMessageCount).toBe(1);

    await manager.dispose();
    await expect(dispatch).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(events).toEqual([
      "start:feishu",
      "start:dingtalk",
      "stop:dingtalk",
      "stop:feishu",
    ]);
    expect(manager.status).toMatchObject({
      inFlightMessageCount: 0,
      state: LIFECYCLE_STATES.DISPOSED,
    });
  });

  it("rolls back every attempted adapter when startup fails", async () => {
    const events: string[] = [];
    const first = new FakeAdapter("feishu", events);
    const second = new FakeAdapter("dingtalk", events, true);
    const manager = new ChannelManager({
      adapters: [first, second],
      dispatcher: new RecordingDispatcher(),
    });

    await expect(manager.initialize()).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });
    expect(events).toEqual([
      "start:feishu",
      "start:dingtalk",
      "stop:dingtalk",
      "stop:feishu",
    ]);
    expect(manager.status.state).toBe(LIFECYCLE_STATES.FAILED);

    await manager.dispose();
    expect(manager.status.state).toBe(LIFECYCLE_STATES.DISPOSED);
  });

  it("rejects duplicate adapter IDs and messages after disposal", async () => {
    const events: string[] = [];
    expect(() => new ChannelManager({
      adapters: [
        new FakeAdapter("feishu", events),
        new FakeAdapter("feishu", events),
      ],
      dispatcher: new RecordingDispatcher(),
    })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.CONFLICT }),
    );

    const adapter = new FakeAdapter("feishu", events);
    const manager = new ChannelManager({
      adapters: [adapter],
      dispatcher: new RecordingDispatcher(),
    });
    await manager.initialize();
    await manager.dispose();

    await expect(adapter.emit(createMessage())).rejects.toMatchObject({
      code: ERROR_CODES.CONFLICT,
    });
  });
});

class FakeAdapter implements ChannelAdapter {
  private context: ChannelAdapterStartContext | undefined;

  constructor(
    readonly id: string,
    private readonly events: string[],
    private readonly failStart = false,
  ) {}

  emit(
    message: ChannelMessage,
    signal?: AbortSignal,
  ): Promise<ChannelDispatchResult> {
    if (this.context === undefined) {
      return Promise.reject(new Error("adapter has not started"));
    }
    return this.context.onMessage(message, signal);
  }

  send(_reply: ChannelReply, _signal: AbortSignal): void {}

  start(context: ChannelAdapterStartContext): void {
    this.events.push(`start:${this.id}`);
    this.context = context;
    if (this.failStart) {
      throw new Error(`unable to start ${this.id}`);
    }
  }

  stop(): void {
    this.events.push(`stop:${this.id}`);
  }
}

class RecordingDispatcher implements ChannelMessageDispatcher {
  readonly messages: ChannelMessage[] = [];

  async dispatch(
    _adapter: ChannelAdapter,
    message: ChannelMessage,
    _signal?: AbortSignal,
  ): Promise<ChannelDispatchResult> {
    this.messages.push(message);
    return {
      channel: message.channel,
      messageId: message.messageId,
      status: CHANNEL_DISPATCH_STATUSES.NO_REPLY,
    };
  }
}

function createMessage(): ChannelMessage {
  return {
    channel: "feishu",
    conversationId: "conversation-1",
    messageId: "message-1",
    senderId: "user-1",
    text: "question",
    timestamp: 1,
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
