import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortableSleep,
} from "../../../src/foundation/cancellation/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";

describe("abortableSleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the requested delay and releases its timer", async () => {
    vi.useFakeTimers();
    const promise = abortableSleep(100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately on cancellation and clears the timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = abortableSleep(10_000, controller.signal);
    const result = promise.catch((error: unknown) => error);

    controller.abort("manual stop");

    await expect(result).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
      cause: "manual stop",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a timeout reason from an outer signal", async () => {
    vi.useFakeTimers();
    const reason = new BumblebeeError("outer timeout", {
      code: ERROR_CODES.TIMEOUT,
    });
    const controller = new AbortController();
    controller.abort(reason);

    await expect(abortableSleep(100, controller.signal)).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects durations outside the Node timer range", async () => {
    await expect(abortableSleep(-1)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    await expect(abortableSleep(Number.POSITIVE_INFINITY)).rejects.toMatchObject(
      {
        code: ERROR_CODES.INVALID_INPUT,
      },
    );
  });
});
