import type { LifecycleState } from "../../foundation/index.js";

export type ChannelMetadataValue = boolean | number | string | null;
export type ChannelMetadata = Readonly<
  Record<string, ChannelMetadataValue>
>;

/** 平台适配器交给核心层的统一文本消息。 */
export interface ChannelMessage {
  readonly channel: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly metadata?: ChannelMetadata;
  readonly senderId: string;
  readonly text: string;
  readonly timestamp: number;
}

/** 对话端口返回的渠道无关响应。 */
export interface ConversationResponse {
  readonly metadata?: ChannelMetadata;
  readonly text: string;
}

/** 核心层交给平台适配器的统一回复。 */
export interface ChannelReply {
  readonly channel: string;
  readonly conversationId: string;
  readonly inReplyToMessageId: string;
  readonly metadata?: ChannelMetadata;
  readonly text: string;
}

export interface ConversationPort {
  respond(
    message: ChannelMessage,
    signal: AbortSignal,
  ): PromiseLike<ConversationResponse | undefined> | ConversationResponse
    | undefined;
}

export const CHANNEL_DISPATCH_STATUSES = {
  DELIVERED: "delivered",
  DUPLICATE: "duplicate",
  NO_REPLY: "no-reply",
} as const;

export type ChannelDispatchStatus =
  (typeof CHANNEL_DISPATCH_STATUSES)[keyof typeof CHANNEL_DISPATCH_STATUSES];

export interface ChannelDispatchResult {
  readonly channel: string;
  readonly messageId: string;
  readonly status: ChannelDispatchStatus;
}

export type ChannelMessageHandler = (
  message: ChannelMessage,
  signal?: AbortSignal,
) => Promise<ChannelDispatchResult>;

export interface ChannelAdapterStartContext {
  readonly onMessage: ChannelMessageHandler;
  readonly signal: AbortSignal;
}

/**
 * 平台 SDK 只需要实现该端口。
 * stop() 必须幂等，并能清理 start() 部分成功后遗留的资源。
 */
export interface ChannelAdapter {
  readonly id: string;
  send(
    reply: ChannelReply,
    signal: AbortSignal,
  ): PromiseLike<void> | void;
  start(context: ChannelAdapterStartContext): PromiseLike<void> | void;
  stop(): PromiseLike<void> | void;
}

export interface ChannelMessageDispatcher {
  dispatch(
    adapter: ChannelAdapter,
    message: ChannelMessage,
    signal?: AbortSignal,
  ): Promise<ChannelDispatchResult>;
}

export interface ChannelManagerStatus {
  readonly adapterIds: readonly string[];
  readonly inFlightMessageCount: number;
  readonly state: LifecycleState;
}
