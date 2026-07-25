import {
  BumblebeeError,
  ERROR_CODES,
  Lifecycle,
  LIFECYCLE_STATES,
  normalizeError,
  type LifecycleInitializeOptions,
} from "../../foundation/index.js";
import { normalizeChannelId } from "./normalization.js";
import type {
  ChannelAdapter,
  ChannelManagerStatus,
  ChannelMessage,
  ChannelMessageDispatcher,
} from "./types.js";

export interface ChannelManagerOptions {
  readonly adapters: readonly ChannelAdapter[];
  readonly dispatcher: ChannelMessageDispatcher;
}

/** 管理适配器启动、失败回滚、消息取消和逆序关闭。 */
export class ChannelManager {
  private readonly adapters: readonly ChannelAdapter[];
  private readonly adapterIds: readonly string[];
  private readonly dispatcher: ChannelMessageDispatcher;
  private readonly inFlightMessages = new Set<Promise<unknown>>();
  private readonly lifecycle = new Lifecycle();

  constructor(options: ChannelManagerOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      !Array.isArray(options.adapters) ||
      options.adapters.length === 0 ||
      typeof options.dispatcher?.dispatch !== "function"
    ) {
      throw new BumblebeeError(
        "ChannelManager requires adapters and a dispatcher",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }

    const ids = new Set<string>();
    for (const adapter of options.adapters) {
      assertManagedAdapter(adapter);
      const id = normalizeChannelId(adapter.id);
      if (ids.has(id)) {
        throw new BumblebeeError(`Duplicate channel adapter: ${id}`, {
          code: ERROR_CODES.CONFLICT,
          context: { channel: id },
        });
      }
      ids.add(id);
    }

    this.adapters = Object.freeze([...options.adapters]);
    this.adapterIds = Object.freeze([...ids]);
    this.dispatcher = options.dispatcher;
  }

  get status(): ChannelManagerStatus {
    return Object.freeze({
      adapterIds: this.adapterIds,
      inFlightMessageCount: this.inFlightMessages.size,
      state: this.lifecycle.state,
    });
  }

  initialize(options: LifecycleInitializeOptions = {}): Promise<void> {
    return this.lifecycle.initialize(async ({ defer, signal }) => {
      // 先登记 drain，使关闭时先停止所有适配器，再等待在途回调。
      defer("channel-message-drain", () => this.drainInFlightMessages());

      for (const adapter of this.adapters) {
        const channel = normalizeChannelId(adapter.id);
        defer(`channel-adapter:${channel}`, async () => {
          try {
            await adapter.stop();
          } catch (cause: unknown) {
            throw normalizeError(cause, {
              code: ERROR_CODES.UNAVAILABLE,
              context: { channel },
              message: "Channel adapter failed to stop",
              retryable: true,
            });
          }
        });

        try {
          await adapter.start(Object.freeze({
            onMessage: (
              message: ChannelMessage,
              messageSignal?: AbortSignal,
            ) =>
              this.handleMessage(
                adapter,
                message,
                signal,
                messageSignal,
              ),
            signal,
          }));
        } catch (cause: unknown) {
          throw normalizeError(cause, {
            code: ERROR_CODES.UNAVAILABLE,
            context: { channel },
            message: "Channel adapter failed to start",
            retryable: true,
            userMessage: `渠道 ${channel} 启动失败。`,
          });
        }
      }
    }, options);
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private handleMessage(
    adapter: ChannelAdapter,
    message: ChannelMessage,
    managerSignal: AbortSignal,
    messageSignal?: AbortSignal,
  ) {
    if (
      this.lifecycle.state !== LIFECYCLE_STATES.INITIALIZING &&
      this.lifecycle.state !== LIFECYCLE_STATES.READY
    ) {
      return Promise.reject(
        new BumblebeeError("Channel manager is not accepting messages", {
          code: ERROR_CODES.CONFLICT,
          context: { state: this.lifecycle.state },
        }),
      );
    }

    const signal = messageSignal === undefined
      ? managerSignal
      : AbortSignal.any([managerSignal, messageSignal]);
    const operation = this.dispatcher.dispatch(adapter, message, signal);
    this.trackMessage(operation);
    return operation;
  }

  private trackMessage(promise: Promise<unknown>): void {
    this.inFlightMessages.add(promise);
    void promise.then(
      () => this.inFlightMessages.delete(promise),
      () => this.inFlightMessages.delete(promise),
    );
  }

  private async drainInFlightMessages(): Promise<void> {
    while (this.inFlightMessages.size > 0) {
      await Promise.allSettled([...this.inFlightMessages]);
    }
  }
}

function assertManagedAdapter(
  value: ChannelAdapter,
): asserts value is ChannelAdapter {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.send !== "function" ||
    typeof value.start !== "function" ||
    typeof value.stop !== "function"
  ) {
    throw new BumblebeeError("Channel adapter is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
}
