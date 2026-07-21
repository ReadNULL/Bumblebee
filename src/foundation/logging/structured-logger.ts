import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";
import {
  sanitizeForLogging,
  type SanitizeOptions,
} from "./sanitizer.js";
import type {
  JsonObject,
  JsonValue,
  LogDetails,
  LogFields,
  LogLevel,
  LogRecord,
  LogSink,
} from "./types.js";
import { TraceContext } from "./trace-context.js";

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLoggerOptions {
  readonly clock: () => Date;
  readonly fields?: LogFields;
  readonly minLevel?: LogLevel;
  readonly sanitize?: SanitizeOptions;
  readonly scope?: string;
  readonly sink: LogSink;
  readonly traceContext: TraceContext;
}

/** 传输无关的结构化 logger；上层决定记录写往文件、终端还是远程系统。 */
export class StructuredLogger {
  private readonly baseFields: JsonObject;
  private readonly clock: () => Date;
  private readonly minLevel: LogLevel;
  private readonly sanitizeOptions: SanitizeOptions;
  private readonly scope: string | undefined;
  private readonly sink: LogSink;
  private readonly traceContext: TraceContext;

  constructor(options: StructuredLoggerOptions) {
    this.clock = options.clock;
    this.minLevel = options.minLevel ?? "info";
    this.sanitizeOptions = copySanitizeOptions(options.sanitize);
    this.scope = normalizeOptionalScope(options.scope);
    this.sink = options.sink;
    this.traceContext = options.traceContext;
    this.baseFields = sanitizeFields(
      options.fields ?? {},
      this.sanitizeOptions,
    );
  }

  child(scope: string, fields?: LogFields): StructuredLogger {
    const normalizedScope = normalizeRequiredScope(scope);
    const childScope =
      this.scope === undefined
        ? normalizedScope
        : `${this.scope}.${normalizedScope}`;

    return new StructuredLogger({
      clock: this.clock,
      fields: mergeJsonObjects(
        this.baseFields,
        sanitizeFields(fields ?? {}, this.sanitizeOptions),
      ),
      minLevel: this.minLevel,
      sanitize: this.sanitizeOptions,
      scope: childScope,
      sink: this.sink,
      traceContext: this.traceContext,
    });
  }

  debug(message: string, details: LogDetails = {}): void {
    this.log("debug", message, details);
  }

  error(message: string, details: LogDetails = {}): void {
    this.log("error", message, details);
  }

  info(message: string, details: LogDetails = {}): void {
    this.log("info", message, details);
  }

  warn(message: string, details: LogDetails = {}): void {
    this.log("warn", message, details);
  }

  log(level: LogLevel, message: string, details: LogDetails = {}): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const dynamicFields = sanitizeFields(
      details.fields ?? {},
      this.sanitizeOptions,
    );
    const fields = mergeJsonObjects(this.baseFields, dynamicFields);
    const traceId = this.traceContext.getTraceId();
    const hasError = Object.prototype.hasOwnProperty.call(details, "error");

    const record: LogRecord = Object.freeze({
      timestamp: this.clock().toISOString(),
      level,
      message: sanitizeMessage(message, this.sanitizeOptions),
      ...(this.scope === undefined ? {} : { scope: this.scope }),
      ...(traceId === undefined ? {} : { traceId }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(hasError
        ? { error: sanitizeForLogging(details.error, this.sanitizeOptions) }
        : {}),
    });

    this.sink(record);
  }
}

/** 创建 JSON Lines sink；writer 接收的每条字符串都以换行符结尾。 */
export function createJsonLineSink(writer: (line: string) => void): LogSink {
  return (record) => {
    writer(`${JSON.stringify(record)}\n`);
  };
}

function sanitizeMessage(
  message: string,
  options: SanitizeOptions,
): string {
  const value = sanitizeForLogging(message, options);

  if (typeof value !== "string") {
    throw new BumblebeeError("Sanitized log message must be a string", {
      code: ERROR_CODES.INTERNAL,
    });
  }

  return value;
}

function sanitizeFields(
  fields: LogFields,
  options: SanitizeOptions,
): JsonObject {
  const value = sanitizeForLogging(fields, options);

  return isJsonObject(value) ? value : { value };
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeJsonObjects(...objects: readonly JsonObject[]): JsonObject {
  return Object.assign(Object.create(null), ...objects) as JsonObject;
}

function normalizeOptionalScope(scope: string | undefined): string | undefined {
  return scope === undefined ? undefined : normalizeRequiredScope(scope);
}

function normalizeRequiredScope(scope: string): string {
  const normalizedScope = scope.trim();

  if (normalizedScope.length === 0) {
    throw new BumblebeeError("Log scope cannot be empty", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }

  return normalizedScope;
}

function copySanitizeOptions(
  options: SanitizeOptions | undefined,
): SanitizeOptions {
  if (options === undefined) {
    return {};
  }

  return {
    ...(options.additionalSensitiveKeys === undefined
      ? {}
      : { additionalSensitiveKeys: [...options.additionalSensitiveKeys] }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxEntries === undefined
      ? {}
      : { maxEntries: options.maxEntries }),
    ...(options.maxStringLength === undefined
      ? {}
      : { maxStringLength: options.maxStringLength }),
  };
}
