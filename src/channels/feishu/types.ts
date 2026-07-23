export const FEISHU_CHANNEL_ID = "feishu";

export type FeishuAllowedSenderIds = "*" | ReadonlySet<string>;

export interface FeishuConfig {
  readonly allowedSenderIds: FeishuAllowedSenderIds;
  readonly appId: string;
  readonly appSecret: string;
}

export interface FeishuReplyRequest {
  readonly messageId: string;
  readonly requestId: string;
  readonly text: string;
}

export type FeishuEventHandler = (event: unknown) => void;

/** 隔离官方 SDK，便于在不连接飞书的情况下测试适配器语义。 */
export interface FeishuGateway {
  reply(request: FeishuReplyRequest, signal: AbortSignal): Promise<void>;
  start(handler: FeishuEventHandler, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface FeishuDiagnosticLogger {
  debug(message: string): void;
  error(message: string, cause?: unknown): void;
  info(message: string): void;
  warn(message: string, cause?: unknown): void;
}

export const SILENT_FEISHU_LOGGER: FeishuDiagnosticLogger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  warn() {},
});
