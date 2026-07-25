import { describe, expect, it, vi } from "vitest";

import {
  Semaphore,
} from "../../../src/foundation/concurrency/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";

describe("Semaphore", () => {
  it("rejects invalid concurrency limits", () => {
    for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new Semaphore(limit)).toThrowError(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
      );
    }
  });

  it("grants permits in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const order: string[] = [];
    const secondPromise = semaphore.acquire().then((permit) => {
      order.push("second");
      return permit;
    });
    const thirdPromise = semaphore.acquire().then((permit) => {
      order.push("third");
      return permit;
    });

    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.availableCount).toBe(0);
    expect(semaphore.pendingCount).toBe(2);

    first.release();
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    expect(semaphore.pendingCount).toBe(1);

    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);

    third.release();
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.availableCount).toBe(1);
    expect(semaphore.pendingCount).toBe(0);
  });

  it("never runs more operations than its limit", async () => {
    const semaphore = new Semaphore(2);
    const gates = [createGate(), createGate(), createGate()] as const;
    const started: number[] = [];
    let running = 0;
    let maximumRunning = 0;
    const operations = gates.map((gate, index) =>
      semaphore.runExclusive(async () => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        started.push(index);
        await gate.promise;
        running -= 1;
      }),
    );

    try {
      await Promise.resolve();
      expect(started).toEqual([0, 1]);
      expect(maximumRunning).toBe(2);
      expect(semaphore.pendingCount).toBe(1);

      gates[0].open();
      await operations[0];
      await Promise.resolve();
      expect(started).toEqual([0, 1, 2]);
      expect(maximumRunning).toBe(2);
    } finally {
      for (const gate of gates) {
        gate.open();
      }
      await Promise.allSettled(operations);
    }
  });

  it("removes a cancelled waiter without blocking later waiters", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const cancelled = semaphore.acquire({ signal: controller.signal });
    const cancelledResult = cancelled.catch((error: unknown) => error);
    const nextPromise = semaphore.acquire();

    controller.abort("request closed");

    await expect(cancelledResult).resolves.toMatchObject({
      cause: "request closed",
      code: ERROR_CODES.CANCELLED,
    });
    expect(semaphore.pendingCount).toBe(1);

    first.release();
    const next = await nextPromise;
    expect(semaphore.activeCount).toBe(1);
    next.release();
  });

  it("preserves a typed timeout reason while waiting", async () => {
    const semaphore = new Semaphore(1);
    const permit = await semaphore.acquire();
    const controller = new AbortController();
    const timeout = new BumblebeeError("outer deadline", {
      code: ERROR_CODES.TIMEOUT,
    });
    const waiting = semaphore.acquire({ signal: controller.signal });
    const result = waiting.catch((error: unknown) => error);

    controller.abort(timeout);

    await expect(result).resolves.toBe(timeout);
    expect(semaphore.pendingCount).toBe(0);
    permit.release();
  });

  it("does not enqueue a pre-cancelled acquisition", async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    controller.abort("already closed");

    await expect(
      semaphore.acquire({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CANCELLED });
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });

  it("makes permit release idempotent", async () => {
    const semaphore = new Semaphore(1);
    const permit = await semaphore.acquire();

    permit.release();
    permit.release();

    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.availableCount).toBe(1);
  });

  it("releases capacity after operation failure", async () => {
    const semaphore = new Semaphore(1);
    const failure = new Error("operation failed");

    await expect(
      semaphore.runExclusive(() => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(semaphore.activeCount).toBe(0);

    await expect(
      semaphore.runExclusive(() => "next"),
    ).resolves.toBe("next");
  });

  it("skips an operation cancelled after its permit is granted", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const operation = vi.fn(() => "unexpected");
    const waiting = semaphore.runExclusive(operation, {
      signal: controller.signal,
    });
    const result = waiting.catch((error: unknown) => error);

    first.release();
    controller.abort("cancelled before start");

    await expect(result).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(semaphore.activeCount).toBe(0);
  });
});

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
