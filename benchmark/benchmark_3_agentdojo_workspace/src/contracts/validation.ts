import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";

export function invalid(
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context,
  });
}

export function requireRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalid(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireString(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    invalid(`${field} must be a non-empty single-line string`);
  }
  return value;
}

export function requireMultilineString(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\u0000")
  ) {
    invalid(`${field} must be a non-empty string`);
  }
  return value;
}

export function requireNonNegativeNumber(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    invalid(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function requirePositiveInteger(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    invalid(`${field} must be a positive safe integer`);
  }
  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function requireBoolean(
  value: unknown,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    invalid(`${field} must be a boolean`);
  }
  return value;
}

export function requireArray(
  value: unknown,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array`);
  }
  return value;
}

export function requireIsoDate(
  value: unknown,
  field: string,
): string {
  const text = requireString(value, field);
  if (
    !text.includes("T") ||
    !Number.isFinite(Date.parse(text))
  ) {
    invalid(`${field} must be an ISO timestamp`);
  }
  return text;
}

export function requireSha256(
  value: unknown,
  field: string,
): string {
  const text = requireString(value, field);
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    invalid(`${field} must be a lowercase SHA-256 digest`);
  }
  return text;
}

export function requireOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const text = requireString(value, field);
  if (!allowed.includes(text as T)) {
    invalid(`${field} has an unsupported value`, {
      actual: text,
      allowed,
    });
  }
  return text as T;
}
