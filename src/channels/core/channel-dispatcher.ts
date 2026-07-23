import { createHash } from "node:crypto";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../runtime/index.js";
import { MessageDeduplicator } from "./message-deduplicator.js";
import {
  createChannelReply,
  normalizeChannelId,
  normalizeChannelMessage,
  normalizeConversationResponse,
} from "./normalization.js";
import {
  CHANNEL_DISPATCH_STATUSES,
  type ChannelAdapter,
  type ChannelDispatchResult,
  type ChannelMessage,
  type ConversationPort,
} from "./types.js";

const CHANNEL_OPERATION_NAME = "channel.message";

export interface ChannelExecutionRuntime {
  execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T>;
}

export interface ChannelDispatcherOptions {
  readonly conversation: ConversationPort;
  readonly deduplicator?: MessageDeduplicator;
  readonly runtime: ChannelExecutionRuntime;
  readonly timeoutMs?: number;
}

/** 规范化消息，在运行时中按会话调度，并把对话结果发送回原适配器。 */
export class ChannelDispatcher {
  private readonly conversation: ConversationPort;
  private readonly deduplicator: MessageDeduplicator;
  private readonly runtime: ChannelExecutionRuntime;
  private readonly timeoutMs: number | undefined;

  constructor(options: ChannelDispatcherOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.runtime?.execute !== "function" ||
      typeof options.conversation?.respond !== "function"
    ) {
      throw new BumblebeeError(
        "ChannelDispatcher requires runtime and conversation ports",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new BumblebeeError(
        "timeoutMs must be a positive safe integer",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { fieldName: "timeoutMs" },
        },
      );
    }

    this.conversation = options.conversation;
    this.deduplicator =
      options.deduplicator ?? new MessageDeduplicator();
    this.runtime = options.runtime;
    this.timeoutMs = options.timeoutMs;
  }

  async dispatch(
    adapter: ChannelAdapter,
    rawMessage: ChannelMessage,
    signal?: AbortSignal,
  ): Promise<ChannelDispatchResult> {
    throwIfAborted(signal);
    assertAdapter(adapter);

    const channel = normalizeChannelId(adapter.id);
    const message = normalizeChannelMessage(rawMessage, channel);
    const deduplicationKey = `${channel}\u0000${message.messageId}`;
    const lease = this.deduplicator.tryAcquire(deduplicationKey);
    if (lease === undefined) {
      return createResult(message, CHANNEL_DISPATCH_STATUSES.DUPLICATE);
    }

    let operationStarted = false;
    const request: TaskExecutionRequest = {
      operationName: CHANNEL_OPERATION_NAME,
      sessionKey: createSessionKey(message),
      ...(signal === undefined ? {} : { signal }),
      ...(this.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.timeoutMs }),
      traceId: createTraceId(message),
    };

    try {
      return await this.runtime.execute(
        request,
        async ({ logger, signal: runtimeSignal }) => {
          operationStarted = true;
          try {
            throwIfAborted(runtimeSignal);
            logger.debug("channel message started", {
              fields: { channel: message.channel },
            });

            const response = normalizeConversationResponse(
              await this.conversation.respond(message, runtimeSignal),
            );
            throwIfAborted(runtimeSignal);

            if (response === undefined) {
              lease.commit();
              logger.info("channel message completed without reply", {
                fields: {
                  channel: message.channel,
                  status: CHANNEL_DISPATCH_STATUSES.NO_REPLY,
                },
              });
              return createResult(
                message,
                CHANNEL_DISPATCH_STATUSES.NO_REPLY,
              );
            }

            const reply = createChannelReply(message, response);
            try {
              await adapter.send(reply, runtimeSignal);
            } catch (cause: unknown) {
              throw normalizeError(cause, {
                code: ERROR_CODES.UNAVAILABLE,
                context: { channel: message.channel },
                message: "Channel adapter failed to send a reply",
                retryable: true,
                userMessage: "渠道回复发送失败，请稍后重试。",
              });
            }

            lease.commit();
            logger.info("channel reply delivered", {
              fields: {
                channel: message.channel,
                status: CHANNEL_DISPATCH_STATUSES.DELIVERED,
              },
            });
            return createResult(
              message,
              CHANNEL_DISPATCH_STATUSES.DELIVERED,
            );
          } catch (cause: unknown) {
            lease.release();
            throw normalizeError(cause, {
              context: { channel: message.channel },
              message: "Channel message processing failed",
            });
          }
        },
      );
    } catch (cause: unknown) {
      // 排队前失败时 operation 不会获得释放租约的机会。
      if (!operationStarted) {
        lease.release();
      }
      throw normalizeError(cause, {
        context: { channel: message.channel },
        message: "Channel dispatch failed",
      });
    }
  }
}

function assertAdapter(
  value: ChannelAdapter,
): asserts value is ChannelAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.send !== "function"
  ) {
    throw new BumblebeeError("Channel adapter is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
}

function createResult(
  message: ChannelMessage,
  status: ChannelDispatchResult["status"],
): ChannelDispatchResult {
  return Object.freeze({
    channel: message.channel,
    messageId: message.messageId,
    status,
  });
}

function createSessionKey(message: ChannelMessage): string {
  return `channel:${message.channel}:${fingerprint(message.conversationId)}`;
}

function createTraceId(message: ChannelMessage): string {
  return `channel-message:${fingerprint(
    `${message.channel}\u0000${message.messageId}`,
  )}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
