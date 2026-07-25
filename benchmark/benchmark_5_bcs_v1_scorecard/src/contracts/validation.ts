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

export function requireFiniteNumber(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  field: string,
): number {
  const number = requireFiniteNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    invalid(`${field} must be a non-negative safe integer`);
  }
  return number;
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

export function requireMetricMap(
  value: unknown,
  field: string,
): Readonly<Record<string, number>> {
  const source = requireRecord(value, field);
  const metrics: Record<string, number> = {};
  for (const [key, metric] of Object.entries(source)) {
    metrics[key] = requireFiniteNumber(metric, `${field}.${key}`);
  }
  return Object.freeze(metrics);
}
