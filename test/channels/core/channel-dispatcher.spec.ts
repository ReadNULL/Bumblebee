import { describe, expect, it } from "vitest";

import {
  CHANNEL_DISPATCH_STATUSES,
  ChannelDispatcher,
  type ChannelAdapter,
  type ChannelMessage,
  type ChannelReply,
  type ConversationPort,
} from "../../../src/channels/index.js";
import {
  ERROR_CODES,
  StructuredLogger,
  TraceContext,
  type LogRecord,
} from "../../../src/foundation/index.js";
import type {
  TaskExecutionContext,
  TaskExecutionRequest,
  TaskOperation,
} from "../../../src/runtime/index.js";

describe("ChannelDispatcher", () => {
  it("normalizes, dispatches, and sends one reply without logging content", async () => {
    const records: LogRecord[] = [];
    const runtime = new RecordingRuntime(records);
    const received: ChannelMessage[] = [];
    const replies: ChannelReply[] = [];
    const adapter = createAdapter(replies);
    const dispatcher = new ChannelDispatcher({
      conversation: {
        respond(message) {
          received.push(message);
          return {
            metadata: { format: "text" },
            text: "private answer",
          };
        },
      },
      runtime,
    });

    const result = await dispatcher.dispatch(
      adapter,
      createMessage({ text: "private question" }),
    );

    expect(result).toEqual({
      channel: "feishu",
      messageId: "message-1",
      status: CHANNEL_DISPATCH_STATUSES.DELIVERED,
    });
    expect(received).toHaveLength(1);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(replies).toEqual([{
      channel: "feishu",
      conversationId: "conversation-1",
      inReplyToMessageId: "message-1",
      metadata: { format: "text" },
      text: "private answer",
    }]);

    expect(runtime.requests[0]?.sessionKey).not.toContain("conversation-1");
    expect(runtime.requests[0]?.traceId).not.toContain("message-1");
    const serializedLogs = JSON.stringify(records);
    expect(serializedLogs).not.toContain("private question");
    expect(serializedLogs).not.toContain("private answer");

    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).resolves.toMatchObject({
      status: CHANNEL_DISPATCH_STATUSES.DUPLICATE,
    });
    expect(received).toHaveLength(1);
    expect(replies).toHaveLength(1);
    runtime.dispose();
  });

  it("treats an undefined response as successfully handled without reply", async () => {
    const runtime = new RecordingRuntime();
    const replies: ChannelReply[] = [];
    const dispatcher = new ChannelDispatcher({
      conversation: { respond: () => undefined },
      runtime,
    });

    await expect(
      dispatcher.dispatch(createAdapter(replies), createMessage()),
    ).resolves.toMatchObject({
      status: CHANNEL_DISPATCH_STATUSES.NO_REPLY,
    });
    expect(replies).toEqual([]);
    runtime.dispose();
  });

  it("blocks a concurrent duplicate while the first message is in flight", async () => {
    const runtime = new RecordingRuntime();
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    let calls = 0;
    const dispatcher = new ChannelDispatcher({
      conversation: {
        async respond() {
          calls += 1;
          started.resolve();
          await gate.promise;
          return { text: "answer" };
        },
      },
      runtime,
    });
    const adapter = createAdapter([]);

    const first = dispatcher.dispatch(adapter, createMessage());
    await started.promise;
    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).resolves.toMatchObject({
      status: CHANNEL_DISPATCH_STATUSES.DUPLICATE,
    });
    gate.resolve();
    await first;
    expect(calls).toBe(1);
    runtime.dispose();
  });

  it("releases the message ID after a processing failure", async () => {
    const runtime = new RecordingRuntime();
    let calls = 0;
    const conversation: ConversationPort = {
      respond() {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary provider failure");
        }
        return { text: "recovered" };
      },
    };
    const dispatcher = new ChannelDispatcher({ conversation, runtime });
    const adapter = createAdapter([]);

    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).rejects.toMatchObject({ code: ERROR_CODES.INTERNAL });
    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).resolves.toMatchObject({
      status: CHANNEL_DISPATCH_STATUSES.DELIVERED,
    });
    expect(calls).toBe(2);
    runtime.dispose();
  });

  it("releases the message ID when reply delivery fails", async () => {
    const runtime = new RecordingRuntime();
    let conversationCalls = 0;
    let sendCalls = 0;
    const dispatcher = new ChannelDispatcher({
      conversation: {
        respond() {
          conversationCalls += 1;
          return { text: "answer" };
        },
      },
      runtime,
    });
    const adapter: ChannelAdapter = {
      id: "feishu",
      send() {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw new Error("temporary send failure");
        }
      },
      start() {},
      stop() {},
    };

    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });
    await expect(
      dispatcher.dispatch(adapter, createMessage()),
    ).resolves.toMatchObject({
      status: CHANNEL_DISPATCH_STATUSES.DELIVERED,
    });
    expect(conversationCalls).toBe(2);
    expect(sendCalls).toBe(2);
    runtime.dispose();
  });

  it("uses stable session keys per conversation without exposing identifiers", async () => {
    const runtime = new RecordingRuntime();
    const dispatcher = new ChannelDispatcher({
      conversation: { respond: () => undefined },
      runtime,
    });
    const adapter = createAdapter([]);

    await dispatcher.dispatch(adapter, createMessage({ messageId: "m-1" }));
    await dispatcher.dispatch(adapter, createMessage({ messageId: "m-2" }));
    await dispatcher.dispatch(
      adapter,
      createMessage({
        conversationId: "conversation-2",
        messageId: "m-3",
      }),
    );

    expect(runtime.requests[0]?.sessionKey)
      .toBe(runtime.requests[1]?.sessionKey);
    expect(runtime.requests[2]?.sessionKey)
      .not.toBe(runtime.requests[0]?.sessionKey);
    expect(runtime.requests.map((request) => request.sessionKey).join(""))
      .not.toContain("conversation-");
    runtime.dispose();
  });

  it("rejects messages attributed to a different adapter", async () => {
    const runtime = new RecordingRuntime();
    const dispatcher = new ChannelDispatcher({
      conversation: { respond: () => undefined },
      runtime,
    });

    await expect(
      dispatcher.dispatch(
        createAdapter([]),
        createMessage({ channel: "dingtalk" }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    runtime.dispose();
  });
});

class RecordingRuntime {
  readonly requests: TaskExecutionRequest[] = [];
  private readonly logger: StructuredLogger;
  private readonly traceContext = new TraceContext();

  constructor(records: LogRecord[] = []) {
    this.logger = new StructuredLogger({
      clock: () => new Date("2026-07-23T00:00:00.000Z"),
      minLevel: "debug",
      scope: "test",
      sink: (record) => records.push(record),
      traceContext: this.traceContext,
    });
  }

  async execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T> {
    this.requests.push(request);
    const signal = request.signal ?? new AbortController().signal;
    const context: TaskExecutionContext = Object.freeze({
      logger: this.logger,
      signal,
      traceId: request.traceId ?? "test-trace",
    });
    return await operation(context);
  }

  dispose(): void {
    this.traceContext.dispose();
  }
}

function createAdapter(replies: ChannelReply[]): ChannelAdapter {
  return {
    id: "feishu",
    send(reply) {
      replies.push(reply);
    },
    start() {},
    stop() {},
  };
}

function createMessage(
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    channel: "feishu",
    conversationId: "conversation-1",
    messageId: "message-1",
    senderId: "user-1",
    text: "question",
    timestamp: 1,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}
