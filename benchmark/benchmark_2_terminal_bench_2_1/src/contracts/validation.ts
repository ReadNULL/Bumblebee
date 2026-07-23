import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";

export function requireRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalid(`${field} must be an object`, { field });
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireArray(
  value: unknown,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array`, { field });
  }
  return value;
}

export function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

export function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, field);
}

export function requireNumber(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`, { field });
  }
  return value;
}

export function optionalNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireNumber(value, field);
}

export function requirePositiveInteger(
  value: unknown,
  field: string,
): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) {
    invalid(`${field} must be a positive safe integer`, {
      field,
      value,
    });
  }
  return number;
}

export function requireIsoDate(
  value: unknown,
  field: string,
): string {
  const text = requireString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    invalid(`${field} must be an ISO date`, { field });
  }
  return text;
}

export function invalid(
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context,
  });
}
