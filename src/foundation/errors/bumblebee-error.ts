/**
 * 稳定错误代码用于程序分支、指标聚合和用户文案映射。
 * 调用方不应解析可能变化的 message 来判断错误类型。
 */
export const ERROR_CODES = {
  CANCELLED: "CANCELLED",
  CONFLICT: "CONFLICT",
  INTERNAL: "INTERNAL",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 构造错误时会复制并冻结 context 的第一层，嵌套对象仍由调用方管理。 */
export type ErrorContext = Readonly<Record<string, unknown>>;

export interface BumblebeeErrorOptions {
  readonly code: ErrorCode;
  readonly cause?: unknown;
  readonly context?: ErrorContext;
  readonly retryable?: boolean;
  readonly userMessage?: string;
}

export interface NormalizeErrorOptions {
  readonly code?: ErrorCode;
  readonly context?: ErrorContext;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly userMessage?: string;
}

const DEFAULT_ERROR_MESSAGE = "Unexpected error";

/**
 * Bumblebee 内部统一错误类型。
 * message、cause 和 context 面向诊断；只有 userMessage 可以进入用户界面。
 */
export class BumblebeeError extends Error {
  readonly code: ErrorCode;
  readonly context?: ErrorContext;
  readonly retryable: boolean;
  readonly userMessage?: string;

  constructor(message: string, options: BumblebeeErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    this.name = "BumblebeeError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;

    if (options.context !== undefined) {
      this.context = Object.freeze({ ...options.context });
    }

    if (options.userMessage !== undefined) {
      this.userMessage = options.userMessage;
    }
  }
}

export function isBumblebeeError(value: unknown): value is BumblebeeError {
  return value instanceof BumblebeeError;
}

/**
 * 在 SDK、插件和其他不可信边界将 caught unknown 归一化。
 * 已归一化的错误保持原对象不变，避免重复包装破坏 cause 链。
 */
export function normalizeError(
  value: unknown,
  options: NormalizeErrorOptions = {},
): BumblebeeError {
  if (isBumblebeeError(value)) {
    return value;
  }

  return new BumblebeeError(options.message ?? inferErrorMessage(value), {
    code: options.code ?? ERROR_CODES.INTERNAL,
    cause: value,
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.retryable === undefined
      ? {}
      : { retryable: options.retryable }),
    ...(options.userMessage === undefined
      ? {}
      : { userMessage: options.userMessage }),
  });
}

/** 返回显式批准的用户文案，绝不自动回退到内部 message。 */
export function getUserMessage(value: unknown, fallback: string): string {
  if (
    isBumblebeeError(value) &&
    value.userMessage !== undefined &&
    value.userMessage.trim().length > 0
  ) {
    return value.userMessage;
  }

  return fallback;
}

function inferErrorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return DEFAULT_ERROR_MESSAGE;
}
