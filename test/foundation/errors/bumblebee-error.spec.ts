import { describe, expect, it } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
  getUserMessage,
  isBumblebeeError,
  normalizeError,
} from "../../../src/foundation/errors/index.js";

describe("BumblebeeError", () => {
  it("stores structured error data and preserves the cause", () => {
    const cause = new Error("disk unavailable");
    const mutableContext: Record<string, unknown> = { operation: "load" };
    const error = new BumblebeeError("Unable to load state", {
      code: ERROR_CODES.UNAVAILABLE,
      cause,
      context: mutableContext,
      retryable: true,
      userMessage: "状态暂时无法加载，请稍后重试。",
    });

    mutableContext.operation = "changed";

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BumblebeeError");
    expect(error.code).toBe(ERROR_CODES.UNAVAILABLE);
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ operation: "load" });
    expect(Object.isFrozen(error.context)).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.userMessage).toBe("状态暂时无法加载，请稍后重试。");
  });

  it("defaults retryable to false", () => {
    const error = new BumblebeeError("Invalid value", {
      code: ERROR_CODES.INVALID_INPUT,
    });

    expect(error.retryable).toBe(false);
  });
});

describe("normalizeError", () => {
  it("returns an existing BumblebeeError unchanged", () => {
    const original = new BumblebeeError("Already normalized", {
      code: ERROR_CODES.CONFLICT,
    });

    expect(normalizeError(original)).toBe(original);
    expect(isBumblebeeError(original)).toBe(true);
    expect(isBumblebeeError(new Error("native"))).toBe(false);
  });

  it("wraps a native Error and preserves its message and cause", () => {
    const cause = new Error("connection closed");
    const error = normalizeError(cause);

    expect(error.code).toBe(ERROR_CODES.INTERNAL);
    expect(error.message).toBe("connection closed");
    expect(error.cause).toBe(cause);
  });

  it("uses a thrown string as the internal message", () => {
    const error = normalizeError("  socket closed  ");

    expect(error.message).toBe("socket closed");
    expect(error.cause).toBe("  socket closed  ");
  });

  it("normalizes non-Error values with explicit boundary metadata", () => {
    const thrownValue = { status: 503 };
    const error = normalizeError(thrownValue, {
      code: ERROR_CODES.UNAVAILABLE,
      context: { dependency: "example-sdk" },
      message: "Dependency request failed",
      retryable: true,
    });

    expect(error.code).toBe(ERROR_CODES.UNAVAILABLE);
    expect(error.message).toBe("Dependency request failed");
    expect(error.cause).toBe(thrownValue);
    expect(error.context).toEqual({ dependency: "example-sdk" });
    expect(error.retryable).toBe(true);
  });

  it("uses a stable fallback for values without a useful message", () => {
    expect(normalizeError({ reason: "unknown" }).message).toBe(
      "Unexpected error",
    );
  });
});

describe("getUserMessage", () => {
  it("only exposes an explicitly provided user message", () => {
    const internalOnly = new BumblebeeError("token=secret", {
      code: ERROR_CODES.INTERNAL,
    });
    const userSafe = new BumblebeeError("provider returned 503", {
      code: ERROR_CODES.UNAVAILABLE,
      userMessage: "服务暂时不可用，请稍后重试。",
    });

    expect(getUserMessage(internalOnly, "操作失败。")).toBe("操作失败。");
    expect(getUserMessage(new Error("token=secret"), "操作失败。")).toBe(
      "操作失败。",
    );
    expect(getUserMessage(userSafe, "操作失败。")).toBe(
      "服务暂时不可用，请稍后重试。",
    );
  });
});
