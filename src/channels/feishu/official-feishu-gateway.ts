import * as lark from "@larksuiteoapi/node-sdk";

import {
  BumblebeeError,
  ERROR_CODES,
  getAbortError,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import {
  SILENT_FEISHU_LOGGER,
  type FeishuConfig,
  type FeishuDiagnosticLogger,
  type FeishuEventHandler,
  type FeishuGateway,
  type FeishuReplyRequest,
} from "./types.js";

const APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/iu;
const FEISHU_API_SUCCESS = 0;
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Readiness {
  readonly promise: Promise<void>;
  readonly reject: (cause: unknown) => void;
  readonly resolve: () => void;
  settled: boolean;
}

/** 使用飞书官方 Node SDK 实现长连接与消息回复。 */
export class OfficialFeishuGateway implements FeishuGateway {
  private readonly client: lark.Client;
  private readonly logger: FeishuDiagnosticLogger;
  private readiness: Readiness | undefined;
  private started = false;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private readonly wsClient: lark.WSClient;

  constructor(
    config: FeishuConfig,
    logger: FeishuDiagnosticLogger = SILENT_FEISHU_LOGGER,
  ) {
    if (
      !APP_ID_PATTERN.test(config.appId) ||
      config.appSecret.trim().length === 0
    ) {
      throw new BumblebeeError("Official Feishu gateway config is invalid", {
        code: ERROR_CODES.INVALID_INPUT,
      });
    }

    this.logger = logger;
    const sdkOptions = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: lark.Domain.Feishu,
      logger: SILENT_SDK_LOGGER,
      loggerLevel: lark.LoggerLevel.error,
      source: "bumblebee",
    } as const;
    this.client = new lark.Client(sdkOptions);
    this.wsClient = new lark.WSClient({
      ...sdkOptions,
      autoReconnect: true,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      onError: (cause) => this.handleConnectionError(cause),
      onReady: () => this.handleReady(),
      onReconnected: () => {
        this.logger.info("飞书长连接已恢复。");
      },
      onReconnecting: () => {
        this.logger.warn("飞书长连接已断开，正在重连。");
      },
    });
  }

  async start(
    handler: FeishuEventHandler,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.started || this.stopped || typeof handler !== "function") {
      throw new BumblebeeError("Official Feishu gateway cannot be started", {
        code: ERROR_CODES.CONFLICT,
      });
    }
    this.started = true;
    this.readiness = createReadiness();

    const dispatcher = new lark.EventDispatcher({
      logger: SILENT_SDK_LOGGER,
      loggerLevel: lark.LoggerLevel.error,
    }).register({
      "im.message.receive_v1": (event) => {
        try {
          handler(event);
        } catch (cause: unknown) {
          this.logger.error("飞书事件投递失败。", cause);
        }
      },
    });

    const onAbort = (): void => {
      this.rejectReadiness(getAbortError(signal));
      void this.stop().catch((cause: unknown) => {
        this.logger.error("飞书长连接关闭失败。", cause);
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const sdkStart = this.wsClient.start({ eventDispatcher: dispatcher });
      void sdkStart.then(
        () => {
          if (this.wsClient.getConnectionStatus().state === "connected") {
            this.resolveReadiness();
          }
        },
        (cause: unknown) => this.rejectReadiness(cause),
      );
      await this.readiness.promise;
      throwIfAborted(signal);
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.UNAVAILABLE,
        message: "Feishu WebSocket connection failed",
        retryable: true,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async reply(
    request: FeishuReplyRequest,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.stopped) {
      throw new BumblebeeError("Official Feishu gateway is stopped", {
        code: ERROR_CODES.CONFLICT,
      });
    }

    let result;
    try {
      result = await this.client.im.message.reply({
        data: {
          content: JSON.stringify({ text: request.text }),
          msg_type: "text",
          uuid: request.requestId,
        },
        path: { message_id: request.messageId },
      });
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.UNAVAILABLE,
        message: "Feishu reply API request failed",
        retryable: true,
      });
    }
    throwIfAborted(signal);

    if (
      result.code !== undefined &&
      result.code !== FEISHU_API_SUCCESS
    ) {
      throw new BumblebeeError("Feishu reply API rejected the request", {
        code: ERROR_CODES.UNAVAILABLE,
        context: { apiCode: result.code },
        retryable: true,
      });
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.rejectReadiness(
      new BumblebeeError("Official Feishu gateway stopped", {
        code: ERROR_CODES.CANCELLED,
      }),
    );
    this.closeConnection();
  }

  private closeConnection(): void {
    this.wsClient.close({ force: true });
  }

  private handleConnectionError(cause: Error): void {
    if (this.readiness !== undefined && !this.readiness.settled) {
      this.rejectReadiness(cause);
      return;
    }
    if (!this.stopped) {
      this.logger.error("飞书长连接无法继续重试。", cause);
    }
  }

  private handleReady(): void {
    this.logger.info("飞书长连接已建立。");
    this.resolveReadiness();
  }

  private rejectReadiness(cause: unknown): void {
    const readiness = this.readiness;
    if (readiness === undefined || readiness.settled) {
      return;
    }
    readiness.settled = true;
    readiness.reject(cause);
  }

  private resolveReadiness(): void {
    const readiness = this.readiness;
    if (readiness === undefined || readiness.settled) {
      return;
    }
    readiness.settled = true;
    readiness.resolve();
  }
}

function createReadiness(): Readiness {
  let rejectPromise: (cause: unknown) => void = () => {};
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
    settled: false,
  };
}

const SILENT_SDK_LOGGER: lark.Logger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  trace() {},
  warn() {},
});
