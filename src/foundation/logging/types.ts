export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type LogLevel = "debug" | "error" | "info" | "warn";

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogDetails {
  readonly error?: unknown;
  readonly fields?: LogFields;
}

export interface LogRecord {
  readonly error?: JsonValue;
  readonly fields?: JsonObject;
  readonly level: LogLevel;
  readonly message: string;
  readonly scope?: string;
  readonly timestamp: string;
  readonly traceId?: string;
}

/** 日志传输由上层注入，基础层不直接绑定终端、文件或远程服务。 */
export type LogSink = (record: LogRecord) => void;
