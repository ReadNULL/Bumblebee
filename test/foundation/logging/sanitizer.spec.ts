import { describe, expect, it } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";
import {
  REDACTED_VALUE,
  sanitizeForLogging,
} from "../../../src/foundation/logging/index.js";

describe("sanitizeForLogging", () => {
  it("redacts sensitive keys and common credential patterns", () => {
    const value = sanitizeForLogging(
      {
        password: "hunter2",
        nested: {
          apiKey: "key-123",
          credentials: "clientSecret=client-123 privateKey=private-123",
          message: "request used Bearer token-123",
          sessionId: "session-123",
          tokenCount: 42,
          url: "https://example.test?access_token=secret&ok=1",
        },
      },
      { additionalSensitiveKeys: ["sessionId"] },
    );

    expect(value).toEqual({
      password: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        credentials:
          "clientSecret=[REDACTED] privateKey=[REDACTED]",
        message: "request used Bearer [REDACTED]",
        sessionId: REDACTED_VALUE,
        tokenCount: 42,
        url: "https://example.test?access_token=[REDACTED]&ok=1",
      },
    });
  });

  it("serializes BumblebeeError metadata and its cause safely", () => {
    const cause = new Error("request used Bearer cause-secret");
    const error = new BumblebeeError("provider token=internal-secret failed", {
      code: ERROR_CODES.UNAVAILABLE,
      cause,
      context: { token: "context-secret", operation: "request" },
      retryable: true,
    });

    const value = sanitizeForLogging(error);

    expect(value).toMatchObject({
      name: "BumblebeeError",
      message: "provider token=[REDACTED] failed",
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
      context: {
        token: REDACTED_VALUE,
        operation: "request",
      },
      cause: {
        name: "Error",
        message: "request used Bearer [REDACTED]",
      },
    });
    expect(() => JSON.stringify(value)).not.toThrow();
  });

  it("preserves and sanitizes AggregateError members", () => {
    const error = new AggregateError(
      [
        new Error("disconnect used Bearer cleanup-secret"),
        { token: "nested-secret", resource: "channel" },
      ],
      "cleanup failed",
    );

    const value = sanitizeForLogging(error);

    expect(value).toMatchObject({
      name: "AggregateError",
      message: "cleanup failed",
      errors: [
        {
          name: "Error",
          message: "disconnect used Bearer [REDACTED]",
        },
        {
          token: REDACTED_VALUE,
          resource: "channel",
        },
      ],
    });
  });

  it("handles cycles, unsupported primitives, and throwing getters", () => {
    const circular: Record<string, unknown> = {
      bigint: 12n,
      invalidNumber: Number.NaN,
      missing: undefined,
    };
    circular.self = circular;
    Object.defineProperty(circular, "broken", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    const value = sanitizeForLogging(circular);

    expect(value).toEqual({
      bigint: "12n",
      invalidNumber: "[NaN]",
      missing: "[undefined]",
      self: "[Circular]",
      broken: "[Property access failed]",
    });
    expect(() => JSON.stringify(value)).not.toThrow();
  });

  it("bounds nesting, collection size, and string length", () => {
    expect(
      sanitizeForLogging({ outer: { inner: { value: true } } }, { maxDepth: 2 }),
    ).toEqual({ outer: { inner: "[MaxDepth]" } });

    expect(sanitizeForLogging([1, 2, 3], { maxEntries: 2 })).toEqual([
      1,
      2,
      "[1 items omitted]",
    ]);

    expect(sanitizeForLogging("abcdefgh", { maxStringLength: 5 })).toBe(
      "abcde...[truncated]",
    );
  });

  it("rejects invalid limits with the unified error type", () => {
    let caught: unknown;

    try {
      sanitizeForLogging({}, { maxDepth: 0 });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BumblebeeError);
    expect((caught as BumblebeeError).code).toBe(ERROR_CODES.INVALID_INPUT);
  });
});
