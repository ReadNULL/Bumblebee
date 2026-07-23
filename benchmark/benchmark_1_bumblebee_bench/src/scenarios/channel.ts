import {
  ChannelDispatcher,
  FeishuAdapter,
  type ChannelAdapter,
  type ChannelDispatchResult,
  type ChannelReply,
  type FeishuEventHandler,
  type FeishuGateway,
  type FeishuReplyRequest,
} from "../../../../src/channels/index.js";
import type { ScenarioDefinition } from "../runner/index.js";
import {
  createDeferred,
  createTaskExecutor,
  waitUntil,
} from "./helpers.js";

export const CHANNEL_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "channel-deduplication",
      domain: "Channel",
      async run(context, probe) {
        const { executor, traceContext } = createTaskExecutor(2);
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        let conversationCalls = 0;
        const replies: ChannelReply[] = [];
        const adapter = createChannelAdapter(replies);
        const dispatcher = new ChannelDispatcher({
          conversation: {
            async respond() {
              conversationCalls += 1;
              started.resolve();
              await release.promise;
              return { text: "benchmark reply" };
            },
          },
          runtime: executor,
        });
        let first: Promise<ChannelDispatchResult> | undefined;

        try {
          const message = createChannelMessage();
          first = dispatcher.dispatch(adapter, message, context.signal);
          await started.promise;
          const inFlightDuplicate = await dispatcher.dispatch(
            adapter,
            message,
            context.signal,
          );
          release.resolve();
          const delivered = await first;
          const completedDuplicate = await dispatcher.dispatch(
            adapter,
            message,
            context.signal,
          );

          const sideEffectCount = Math.max(0, conversationCalls - 1) +
            Math.max(0, replies.length - 1);
          probe.check(
            "first-message-delivered",
            delivered.status === "delivered",
          );
          probe.check(
            "in-flight-duplicate-blocked",
            inFlightDuplicate.status === "duplicate",
          );
          probe.check(
            "completed-duplicate-blocked",
            completedDuplicate.status === "duplicate",
          );
          probe.check(
            "single-channel-side-effect",
            conversationCalls === 1 && replies.length === 1,
          );
          probe.metric(
            "duplicate_side_effect_count",
            sideEffectCount,
          );
        } finally {
          release.resolve();
          if (first !== undefined) {
            await Promise.allSettled([first]);
          }
          await executor.dispose();
          traceContext.dispose();
        }
      },
    },
    {
      id: "channel-sender-authorization",
      domain: "Channel",
      async run(context, probe) {
        const gateway = createFeishuGateway();
        let acceptedMessages = 0;
        const adapter = new FeishuAdapter({
          allowedSenderIds: new Set(["ou_owner"]),
          gateway: gateway.gateway,
        });

        await adapter.start({
          async onMessage(message) {
            acceptedMessages += 1;
            return {
              channel: message.channel,
              messageId: message.messageId,
              status: "delivered",
            };
          },
          signal: context.signal,
        });

        try {
          gateway.emit(createFeishuEvent("ou_outsider", "om-outside"));
          await Promise.resolve();
          await Promise.resolve();
          const unauthorizedAccepted = acceptedMessages;

          gateway.emit(createFeishuEvent("ou_owner", "om-owner"));
          const acknowledgedBeforeDispatch = acceptedMessages === 0;
          await waitUntil(() => acceptedMessages === 1, context.signal);

          probe.check(
            "unauthorized-sender-ignored",
            unauthorizedAccepted === 0,
          );
          probe.check(
            "event-handler-acknowledges-first",
            acknowledgedBeforeDispatch,
          );
          probe.check(
            "authorized-sender-dispatched",
            acceptedMessages === 1,
          );
          probe.metric(
            "unauthorized_channel_accept_count",
            unauthorizedAccepted,
          );
        } finally {
          await adapter.stop();
        }
      },
    },
  ]);

function createChannelAdapter(
  replies: ChannelReply[],
): ChannelAdapter {
  return {
    id: "feishu",
    send(reply) {
      replies.push(reply);
    },
    start() {},
    stop() {},
  };
}

function createChannelMessage() {
  return {
    channel: "feishu",
    conversationId: "benchmark-conversation",
    messageId: "benchmark-message",
    senderId: "benchmark-sender",
    text: "benchmark question",
    timestamp: 1,
  } as const;
}

interface FeishuGatewayFixture {
  readonly emit: (event: unknown) => void;
  readonly gateway: FeishuGateway;
}

function createFeishuGateway(): FeishuGatewayFixture {
  let handler: FeishuEventHandler | undefined;
  return {
    emit(event) {
      if (handler === undefined) {
        throw new Error("Feishu benchmark gateway is not started");
      }
      handler(event);
    },
    gateway: {
      async reply(
        _request: FeishuReplyRequest,
        _signal: AbortSignal,
      ) {},
      async start(
        eventHandler: FeishuEventHandler,
        _signal: AbortSignal,
      ) {
        handler = eventHandler;
      },
      async stop() {
        handler = undefined;
      },
    },
  };
}

function createFeishuEvent(
  senderId: string,
  messageId: string,
): unknown {
  return {
    message: {
      chat_id: "oc_benchmark",
      chat_type: "p2p",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1721000000000",
      message_id: messageId,
      message_type: "text",
    },
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
  };
}
