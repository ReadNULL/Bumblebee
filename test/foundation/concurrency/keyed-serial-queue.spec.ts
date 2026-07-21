import { describe, expect, it, vi } from "vitest";

import {
  KeyedSerialQueue,
} from "../../../src/foundation/concurrency/index.js";
import {
  abortableSleep,
  withTimeout,
} from "../../../src/foundation/cancellation/index.js";
import { ERROR_CODES } from "../../../src/foundation/errors/index.js";

function createGate(): {
  readonly promise: Promise<void>;
  readonly open: () => void;
} {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

describe("KeyedSerialQueue", () => {
  it("runs tasks for the same key in FIFO order", async () => {
    const queue = new KeyedSerialQueue<string>();
    const gate = createGate();
    const events: string[] = [];
    const first = queue.enqueue("session-a", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue("session-a", () => {
      events.push("second:start");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    expect(queue.isRunning("session-a")).toBe(true);
    expect(queue.getPendingCount("session-a")).toBe(1);

    gate.open();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.activeKeyCount).toBe(0);
  });

  it("allows different keys to run concurrently", async () => {
    const queue = new KeyedSerialQueue<string>();
    const firstGate = createGate();
    const secondGate = createGate();
    const started: string[] = [];
    const first = queue.enqueue("session-a", async () => {
      started.push("a");
      await firstGate.promise;
    });
    const second = queue.enqueue("session-b", async () => {
      started.push("b");
      await secondGate.promise;
    });

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    expect(queue.activeKeyCount).toBe(2);

    firstGate.open();
    secondGate.open();
    await Promise.all([first, second]);
    expect(queue.activeKeyCount).toBe(0);
  });

  it("continues with the next task after a failure", async () => {
    const queue = new KeyedSerialQueue<string>();
    const failure = new Error("first failed");
    const failed = queue.enqueue("session-a", () => {
      throw failure;
    });
    const failureResult = failed.catch((error: unknown) => error);
    const next = queue.enqueue("session-a", () => "recovered");

    await expect(failureResult).resolves.toBe(failure);
    await expect(next).resolves.toBe("recovered");
    expect(queue.activeKeyCount).toBe(0);
  });

  it("removes a cancelled pending task without invoking it", async () => {
    const queue = new KeyedSerialQueue<string>();
    const gate = createGate();
    const controller = new AbortController();
    const operation = vi.fn(() => "unexpected");
    const first = queue.enqueue("session-a", () => gate.promise);
    const waiting = queue.enqueue("session-a", operation, {
      signal: controller.signal,
    });
    const result = waiting.catch((error: unknown) => error);

    await Promise.resolve();
    controller.abort("message withdrawn");

    await expect(result).resolves.toMatchObject({
      cause: "message withdrawn",
      code: ERROR_CODES.CANCELLED,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(0);

    gate.open();
    await first;
    expect(queue.activeKeyCount).toBe(0);
  });

  it("does not invoke a selected task cancelled before its async start", async () => {
    const queue = new KeyedSerialQueue<string>();
    const controller = new AbortController();
    const operation = vi.fn(() => "unexpected");
    const queued = queue.enqueue("session-a", operation, {
      signal: controller.signal,
    });
    const result = queued.catch((error: unknown) => error);

    controller.abort("cancelled before execution");

    await expect(result).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(queue.activeKeyCount).toBe(0);
  });

  it("passes cancellation to a running cooperative task", async () => {
    const queue = new KeyedSerialQueue<string>();
    const controller = new AbortController();
    const running = queue.enqueue(
      "session-a",
      (signal) => abortableSleep(10_000, signal),
      { signal: controller.signal },
    );
    const result = running.catch((error: unknown) => error);

    await Promise.resolve();
    controller.abort("session closed");

    await expect(result).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(queue.activeKeyCount).toBe(0);
  });

  it("composes with a timeout while waiting for the same key", async () => {
    vi.useFakeTimers();
    try {
      const queue = new KeyedSerialQueue<string>();
      const gate = createGate();
      const operation = vi.fn(() => "unexpected");
      const first = queue.enqueue("session-a", () => gate.promise);
      const timed = withTimeout(
        (signal) => queue.enqueue("session-a", operation, { signal }),
        { timeoutMs: 50 },
      );
      const result = timed.catch((error: unknown) => error);

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toMatchObject({ code: ERROR_CODES.TIMEOUT });
      expect(operation).not.toHaveBeenCalled();
      expect(queue.pendingCount).toBe(0);

      gate.open();
      await first;
      expect(queue.activeKeyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain state for a pre-cancelled task", async () => {
    const queue = new KeyedSerialQueue<string>();
    const controller = new AbortController();
    const operation = vi.fn(() => "unexpected");
    controller.abort("already closed");

    await expect(
      queue.enqueue("session-a", operation, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(operation).not.toHaveBeenCalled();
    expect(queue.activeKeyCount).toBe(0);
  });
});
