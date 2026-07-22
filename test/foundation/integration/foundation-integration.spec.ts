import { describe, expect, it, vi } from "vitest";

import {
  abortableSleep,
  ERROR_CODES,
  KeyedSerialQueue,
  Lifecycle,
  LIFECYCLE_STATES,
  REDACTED_VALUE,
  Semaphore,
  StructuredLogger,
  TraceContext,
  withTimeout,
  type LogRecord,
} from "../../../src/foundation/index.js";

function createGate(): {
  readonly open: () => void;
  readonly promise: Promise<void>;
} {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

describe("foundation integration", () => {
  it("composes tracing, timeout, session ordering, limits, and lifecycle", async () => {
    const records: LogRecord[] = [];
    const traceContext = new TraceContext();
    const logger = new StructuredLogger({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      scope: "integration",
      sink: (record) => records.push(record),
      traceContext,
    });
    const lifecycle = new Lifecycle();
    const sessions = new KeyedSerialQueue<string>();
    const modelSlots = new Semaphore(1);
    const gate = createGate();
    let lifecycleSignal: AbortSignal | undefined;
    let runtimeCleaned = false;

    await lifecycle.initialize(({ defer, signal }) => {
      lifecycleSignal = signal;
      defer("trace-context", () => traceContext.dispose());
      defer("runtime", () => {
        runtimeCleaned = true;
      });
    });
    const activeLifecycleSignal = lifecycleSignal;
    if (activeLifecycleSignal === undefined) {
      throw new Error("Lifecycle signal was not initialized");
    }

    const first = traceContext.run(
      () => withTimeout(
        (timeoutSignal) => sessions.enqueue(
          "session-a",
          (queueSignal) => {
            if (queueSignal === undefined) {
              throw new Error("Queue signal was not propagated");
            }

            return modelSlots.runExclusive(async (slotSignal) => {
              logger.info("request started", {
                fields: { request: "first", token: "first-secret" },
              });
              expect(slotSignal).toBe(queueSignal);
              await gate.promise;
              return "first-result";
            }, { signal: queueSignal });
          },
          { signal: timeoutSignal },
        ),
        {
          operationName: "first request",
          signal: activeLifecycleSignal,
          timeoutMs: 1_000,
        },
      ),
      "trace-first",
    );
    const second = traceContext.run(
      () => withTimeout(
        (timeoutSignal) => sessions.enqueue(
          "session-a",
          (queueSignal) => {
            if (queueSignal === undefined) {
              throw new Error("Queue signal was not propagated");
            }

            return modelSlots.runExclusive(() => {
              logger.info("request started", {
                fields: { request: "second", token: "second-secret" },
              });
              return "second-result";
            }, { signal: queueSignal });
          },
          { signal: timeoutSignal },
        ),
        {
          operationName: "second request",
          signal: activeLifecycleSignal,
          timeoutMs: 1_000,
        },
      ),
      "trace-second",
    );

    await Promise.resolve();
    gate.open();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first-result",
      "second-result",
    ]);
    expect(records.map((record) => record.traceId)).toEqual([
      "trace-first",
      "trace-second",
    ]);
    expect(records.map((record) => record.fields?.token)).toEqual([
      REDACTED_VALUE,
      REDACTED_VALUE,
    ]);
    expect(sessions.activeKeyCount).toBe(0);
    expect(modelSlots.activeCount).toBe(0);

    await lifecycle.dispose();

    expect(runtimeCleaned).toBe(true);
    expect(lifecycleSignal?.aborted).toBe(true);
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
    expect(() => traceContext.run(() => undefined)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.CONFLICT }),
    );
  });

  it("rolls back a timed-out startup and logs the typed failure safely", async () => {
    vi.useFakeTimers();
    const records: LogRecord[] = [];
    const traceContext = new TraceContext();
    const logger = new StructuredLogger({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      sanitize: { maxDepth: 10 },
      sink: (record) => records.push(record),
      traceContext,
    });
    const lifecycle = new Lifecycle();
    const cleanup = vi.fn();

    try {
      const initialization = lifecycle.initialize(async ({ defer, signal }) => {
        defer("startup-resource", cleanup);
        await withTimeout(
          (timeoutSignal) => abortableSleep(10_000, timeoutSignal),
          {
            operationName: "dependency startup",
            signal,
            timeoutMs: 50,
          },
        );
      });
      const result = initialization.catch((error: unknown) => error);

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      const error = await result;

      expect(error).toMatchObject({ code: ERROR_CODES.TIMEOUT });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);

      traceContext.run(() => {
        logger.error("startup failed", {
          error,
          fields: { authorization: "Bearer log-secret" },
        });
      }, "trace-startup");

      expect(records[0]).toMatchObject({
        level: "error",
        traceId: "trace-startup",
        fields: { authorization: REDACTED_VALUE },
        error: { code: ERROR_CODES.TIMEOUT },
      });

      await lifecycle.dispose();
      expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
    } finally {
      traceContext.dispose();
      vi.useRealTimers();
    }
  });
});
