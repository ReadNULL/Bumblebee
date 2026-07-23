import { createHash } from "node:crypto";

import {
  BumblebeeError,
  ERROR_CODES,
  getUserMessage,
  isBumblebeeError,
  normalizeError,
  throwIfAborted,
  withTimeout,
} from "../../foundation/index.js";
import type {
  ChannelAdapter,
  ChannelAdapterStartContext,
  ChannelReply,
} from "../core/index.js";
import { isFeishuSenderAllowed } from "./config.js";
import { parseFeishuMessage } from "./message-parser.js";
import {
  FEISHU_CHANNEL_ID,
  SILENT_FEISHU_LOGGER,
  type FeishuAllowedSenderIds,
  type FeishuDiagnosticLogger,
  type FeishuGateway,
  type FeishuReplyRequest,
} from "./types.js";

export const DEFAULT_FEISHU_STARTUP_TIMEOUT_MS = 30_000;

type AdapterState = "idle" | "starting" | "ready" | "stopping" | "stopped";

export interface FeishuAdapterOptions {
  readonly allowedSenderIds: FeishuAllowedSenderIds;
  readonly gateway: FeishuGateway;
  readonly logger?: FeishuDiagnosticLogger;
  readonly startupTimeoutMs?: number;
}

/**
 * 飞书事件回调只负责解析和投递，绝不等待 Agent 长任务。
 * 这样官方 EventDispatcher 可以在 3 秒窗口内立即确认事件。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly id = FEISHU_CHANNEL_ID;

  private readonly allowedSenderIds: FeishuAllowedSenderIds;
  private context: ChannelAdapterStartContext | undefined;
  private readonly gateway: FeishuGateway;
  private readonly logger: FeishuDiagnosticLogger;
  private readonly startupTimeoutMs: number;
  private state: AdapterState = "idle";
  private stopPromise: Promise<void> | undefined;

  constructor(options: FeishuAdapterOptions) {
    assertGateway(options.gateway);
    this.allowedSenderIds = copyAllowedSenderIds(options.allowedSenderIds);
    this.gateway = options.gateway;
    this.logger = options.logger ?? SILENT_FEISHU_LOGGER;
    this.startupTimeoutMs = normalizeStartupTimeout(
      options.startupTimeoutMs,
    );
  }

  async start(context: ChannelAdapterStartContext): Promise<void> {
    if (
      this.state !== "idle" ||
      typeof context?.onMessage !== "function" ||
      !(context.signal instanceof AbortSignal)
    ) {
      throw new BumblebeeError("Feishu adapter cannot be started", {
        code: ERROR_CODES.CONFLICT,
        context: { state: this.state },
      });
    }

    this.state = "starting";
    this.context = context;

    try {
      await withTimeout(
        (signal) => this.gateway.start(
          (event) => this.handleEvent(event),
          signal,
        ),
        {
          operationName: "feishu websocket startup",
          signal: context.signal,
          timeoutMs: this.startupTimeoutMs,
        },
      );
      throwIfAborted(context.signal);
      if (this.state !== "starting") {
        throw new BumblebeeError(
          "Feishu adapter stopped while it was starting",
          { code: ERROR_CODES.CANCELLED },
        );
      }
      this.state = "ready";
      this.logger.info("飞书渠道已连接。");
    } catch (cause: unknown) {
      let failure: unknown = cause;
      try {
        await this.stop();
      } catch (stopCause: unknown) {
        failure = new AggregateError(
          [cause, stopCause],
          "Feishu startup and rollback both failed",
        );
      }
      throw normalizeError(failure, {
        code: ERROR_CODES.UNAVAILABLE,
        message: "Unable to start Feishu adapter",
        retryable: true,
        userMessage: "飞书渠道连接失败，请检查应用配置和网络。",
      });
    }
  }

  async send(reply: ChannelReply, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.state !== "ready" || reply.channel !== FEISHU_CHANNEL_ID) {
      throw new BumblebeeError("Feishu adapter is not ready for this reply", {
        code: ERROR_CODES.CONFLICT,
        context: { state: this.state },
      });
    }

    await this.gateway.reply(createReplyRequest(reply), signal);
    throwIfAborted(signal);
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private handleEvent(event: unknown): void {
    const context = this.context;
    if (this.state !== "ready" || context === undefined) {
      return;
    }

    let message;
    try {
      message = parseFeishuMessage(event);
    } catch (cause: unknown) {
      this.logger.warn("已忽略格式无效的飞书消息事件。", cause);
      return;
    }
    if (message === undefined) {
      return;
    }
    if (!isFeishuSenderAllowed(this.allowedSenderIds, message.senderId)) {
      this.logger.debug("已忽略不在允许列表中的飞书发送者。");
      return;
    }

    // 延后一拍调用 ChannelManager，确保 SDK 事件处理器先返回确认。
    const operation = Promise.resolve().then(
      () => context.onMessage(message),
    );
    void operation.catch(
      (cause: unknown) => this.handleDispatchFailure(message.messageId, cause),
    );
  }

  private async handleDispatchFailure(
    messageId: string,
    cause: unknown,
  ): Promise<void> {
    this.logger.error("飞书消息处理失败。", cause);

    const context = this.context;
    if (
      this.state !== "ready" ||
      context === undefined ||
      context.signal.aborted ||
      (isBumblebeeError(cause) && cause.code === ERROR_CODES.CANCELLED)
    ) {
      return;
    }

    const text = isBumblebeeError(cause) && cause.code === ERROR_CODES.TIMEOUT
      ? "消息处理超时，请稍后重试。"
      : getUserMessage(cause, "消息处理失败，请稍后重试。");
    try {
      await this.gateway.reply(
        {
          messageId,
          requestId: createReplyRequestId(messageId),
          text,
        },
        context.signal,
      );
    } catch (replyCause: unknown) {
      if (!context.signal.aborted) {
        this.logger.error("飞书错误提示发送失败。", replyCause);
      }
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    this.context = undefined;

    try {
      await this.gateway.stop();
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.UNAVAILABLE,
        message: "Unable to stop Feishu gateway",
        retryable: true,
      });
    } finally {
      this.state = "stopped";
    }
  }
}

function createReplyRequest(reply: ChannelReply): FeishuReplyRequest {
  if (
    typeof reply.inReplyToMessageId !== "string" ||
    reply.inReplyToMessageId.trim().length === 0 ||
    typeof reply.text !== "string" ||
    reply.text.trim().length === 0
  ) {
    throw new BumblebeeError("Feishu reply is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  return Object.freeze({
    messageId: reply.inReplyToMessageId,
    requestId: createReplyRequestId(reply.inReplyToMessageId),
    text: reply.text,
  });
}

function createReplyRequestId(messageId: string): string {
  const digest = createHash("sha256")
    .update("bumblebee.feishu.reply")
    .update("\0")
    .update(messageId)
    .digest("hex")
    .slice(0, 32);
  return `bb_${digest}`;
}

function copyAllowedSenderIds(
  value: FeishuAllowedSenderIds,
): FeishuAllowedSenderIds {
  if (value === "*") {
    return value;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.size === 0 ||
    typeof value.has !== "function" ||
    typeof value[Symbol.iterator] !== "function"
  ) {
    throw new BumblebeeError(
      "Feishu adapter requires at least one allowed sender",
      { code: ERROR_CODES.INVALID_INPUT },
    );
  }
  return new Set(value);
}

function assertGateway(value: FeishuGateway): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.reply !== "function" ||
    typeof value.start !== "function" ||
    typeof value.stop !== "function"
  ) {
    throw new BumblebeeError("Feishu gateway is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
}

function normalizeStartupTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_FEISHU_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new BumblebeeError(
      "startupTimeoutMs must be a positive safe integer",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName: "startupTimeoutMs" },
      },
    );
  }
  return timeout;
}
