import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abortableSleep,
  withTimeout,
} from "../../../src/foundation/cancellation/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a successful result and clears the deadline timer", async () => {
    vi.useFakeTimers();

    await expect(
      withTimeout(async (signal) => {
        expect(signal.aborted).toBe(false);
        return "done";
      }, { timeoutMs: 100 }),
    ).resolves.toBe("done");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns TIMEOUT even when the operation ignores its signal", async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const promise = withTimeout(
      (signal) => {
        childSignal = signal;
        return new Promise<never>(() => {});
      },
      { operationName: "model request", timeoutMs: 100 },
    );
    const result = promise.catch((error: unknown) => error);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;

    expect(error).toMatchObject({
      code: ERROR_CODES.TIMEOUT,
      message: "model request timed out after 100ms",
      context: { operationName: "model request", timeoutMs: 100 },
    });
    expect(childSignal?.aborted).toBe(true);
    expect(childSignal?.reason).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates parent cancellation to the child signal", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const promise = withTimeout(
      (signal) => {
        childSignal = signal;
        return new Promise<never>(() => {});
      },
      { signal: parent.signal, timeoutMs: 1_000 },
    );
    const result = promise.catch((error: unknown) => error);

    await Promise.resolve();
    parent.abort("user cancelled");
    const error = await result;

    expect(error).toMatchObject({
      code: ERROR_CODES.CANCELLED,
      cause: "user cancelled",
    });
    expect(childSignal?.aborted).toBe(true);
    expect(childSignal?.reason).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an operation when the parent is already aborted", async () => {
    const parent = new AbortController();
    parent.abort("cancelled before start");
    const operation = vi.fn(() => "unexpected");

    await expect(
      withTimeout(operation, { signal: parent.signal, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves an ordinary operation failure", async () => {
    vi.useFakeTimers();
    const failure = new Error("operation failed");

    await expect(
      withTimeout(() => Promise.reject(failure), { timeoutMs: 100 }),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a later cancellation overwrite an earlier failure", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const failure = new Error("failed first");
    const promise = withTimeout(() => Promise.reject(failure), {
      signal: parent.signal,
      timeoutMs: 100,
    });
    const result = promise.catch((error: unknown) => error);

    setTimeout(() => parent.abort("cancelled later"), 0);
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts cooperative waits with the same timeout error", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(
      async (signal) => {
        await abortableSleep(10_000, signal);
        return "unexpected";
      },
      { timeoutMs: 50 },
    );
    const result = promise.catch((error: unknown) => error);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    const error = await result;

    expect(error).toMatchObject({ code: ERROR_CODES.TIMEOUT });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an outer typed timeout and rejects invalid deadlines", async () => {
    const parent = new AbortController();
    const outerTimeout = new BumblebeeError("outer timeout", {
      code: ERROR_CODES.TIMEOUT,
    });
    parent.abort(outerTimeout);

    await expect(
      withTimeout(() => "unexpected", {
        signal: parent.signal,
        timeoutMs: 100,
      }),
    ).rejects.toBe(outerTimeout);

    await expect(
      withTimeout(() => "unexpected", { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
  });
});
