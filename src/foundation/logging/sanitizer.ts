import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";
import type { JsonObject, JsonValue } from "./types.js";

export interface SanitizeOptions {
  readonly additionalSensitiveKeys?: readonly string[];
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxStringLength?: number;
}

export const REDACTED_VALUE = "[REDACTED]";

const CIRCULAR_VALUE = "[Circular]";
const MAX_DEPTH_VALUE = "[MaxDepth]";
const PROPERTY_ACCESS_ERROR = "[Property access failed]";
const UNSERIALIZABLE_OBJECT = "[Unserializable object]";

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_STRING_LENGTH = 4_000;

const DEFAULT_SENSITIVE_KEYS = [
  "apiKey",
  "authorization",
  "clientSecret",
  "cookie",
  "password",
  "passwd",
  "privateKey",
  "refreshToken",
  "secret",
  "setCookie",
  "token",
  "accessToken",
] as const;

const SENSITIVE_KEY_SUFFIXES = [
  "apikey",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "secret",
  "token",
] as const;

const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /(["']?\b(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|authorization|cookie)\b["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+\[[^\]]+\]|"[^"]*"|'[^']*'|[^\s,;&}]+)/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

interface ResolvedSanitizeOptions {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxStringLength: number;
  readonly sensitiveKeys: ReadonlySet<string>;
}

interface SanitizeState {
  readonly ancestors: WeakSet<object>;
  readonly options: ResolvedSanitizeOptions;
}

/**
 * 将任意值转换为有界、可 JSON 序列化且完成基础脱敏的结构。
 * 该函数不调用对象的 toJSON，避免执行不可信序列化逻辑。
 */
export function sanitizeForLogging(
  value: unknown,
  options: SanitizeOptions = {},
): JsonValue {
  const state: SanitizeState = {
    ancestors: new WeakSet<object>(),
    options: resolveOptions(options),
  };

  return sanitizeValue(value, 0, state);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: SanitizeState,
): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeString(value, state.options.maxStringLength);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : `[${String(value)}]`;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (typeof value === "undefined") {
    return "[undefined]";
  }

  if (typeof value === "symbol") {
    return String(value);
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (depth >= state.options.maxDepth) {
    return MAX_DEPTH_VALUE;
  }

  if (state.ancestors.has(value)) {
    return CIRCULAR_VALUE;
  }

  state.ancestors.add(value);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
    }

    if (value instanceof Error) {
      return sanitizeError(value, depth, state);
    }

    if (Array.isArray(value)) {
      return sanitizeArray(value, depth, state);
    }

    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor.name} byteLength=${value.byteLength}]`;
    }

    return sanitizeObject(value, depth, state);
  } catch {
    return UNSERIALIZABLE_OBJECT;
  } finally {
    state.ancestors.delete(value);
  }
}

function sanitizeError(
  error: Error,
  depth: number,
  state: SanitizeState,
): JsonObject {
  const output: Record<string, JsonValue> = Object.create(null);

  output.name = sanitizeString(error.name, state.options.maxStringLength);
  output.message = sanitizeString(error.message, state.options.maxStringLength);

  if (error.stack !== undefined) {
    output.stack = sanitizeString(error.stack, state.options.maxStringLength);
  }

  if (error instanceof BumblebeeError) {
    output.code = error.code;
    output.retryable = error.retryable;

    if (error.context !== undefined) {
      output.context = sanitizeValue(error.context, depth + 1, state);
    }
  }

  if (error.cause !== undefined) {
    output.cause = sanitizeValue(error.cause, depth + 1, state);
  }

  return output;
}

function sanitizeArray(
  values: readonly unknown[],
  depth: number,
  state: SanitizeState,
): readonly JsonValue[] {
  const limit = Math.min(values.length, state.options.maxEntries);
  const output: JsonValue[] = [];

  for (let index = 0; index < limit; index += 1) {
    try {
      output.push(sanitizeValue(values[index], depth + 1, state));
    } catch {
      output.push(PROPERTY_ACCESS_ERROR);
    }
  }

  if (values.length > limit) {
    output.push(`[${values.length - limit} items omitted]`);
  }

  return output;
}

function sanitizeObject(
  value: object,
  depth: number,
  state: SanitizeState,
): JsonObject {
  let keys: string[];

  try {
    keys = Object.keys(value);
  } catch {
    return { value: UNSERIALIZABLE_OBJECT };
  }

  const output: Record<string, JsonValue> = Object.create(null);
  const limit = Math.min(keys.length, state.options.maxEntries);

  for (const key of keys.slice(0, limit)) {
    if (isSensitiveKey(key, state.options.sensitiveKeys)) {
      output[key] = REDACTED_VALUE;
      continue;
    }

    try {
      output[key] = sanitizeValue(
        Reflect.get(value, key),
        depth + 1,
        state,
      );
    } catch {
      output[key] = PROPERTY_ACCESS_ERROR;
    }
  }

  if (keys.length > limit) {
    output.$truncated = `${keys.length - limit} properties omitted`;
  }

  return output;
}

function sanitizeString(value: string, maxLength: number): string {
  const redacted = value
    .replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE)
    .replace(AUTHORIZATION_PATTERN, "$1 [REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`);

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, maxLength)}...[truncated]`;
}

function isSensitiveKey(
  key: string,
  sensitiveKeys: ReadonlySet<string>,
): boolean {
  const normalized = normalizeKey(key);

  return (
    sensitiveKeys.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function resolveOptions(options: SanitizeOptions): ResolvedSanitizeOptions {
  const sensitiveKeys = new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(options.additionalSensitiveKeys ?? [])]
      .map(normalizeKey)
      .filter((key) => key.length > 0),
  );

  return {
    maxDepth: resolvePositiveInteger(
      options.maxDepth,
      DEFAULT_MAX_DEPTH,
      "maxDepth",
    ),
    maxEntries: resolvePositiveInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      "maxEntries",
    ),
    maxStringLength: resolvePositiveInteger(
      options.maxStringLength,
      DEFAULT_MAX_STRING_LENGTH,
      "maxStringLength",
    ),
    sensitiveKeys,
  };
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  optionName: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new BumblebeeError(`${optionName} must be a positive integer`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { optionName, value },
    });
  }

  return value;
}
