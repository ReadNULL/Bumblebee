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
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
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

export function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`);
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

export function requirePositiveInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    invalid(`${field} must be a positive integer`);
  }
  return Number(value);
}

export function requireStringArray(
  value: unknown,
  field: string,
  allowEmpty = true,
): readonly string[] {
  const values = requireArray(value, field).map((item, index) =>
    requireString(item, `${field}[${index}]`)
  );
  if (!allowEmpty && values.length === 0) {
    invalid(`${field} must not be empty`);
  }
  return Object.freeze(values);
}

export function requireOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const text = requireString(value, field);
  if (!(allowed as readonly string[]).includes(text)) {
    invalid(`${field} is not supported`, { value: text });
  }
  return text as T;
}

export function requireIsoTimestamp(
  value: unknown,
  field: string,
): string {
  const text = requireString(value, field);
  const parsed = new Date(text);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== text
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
