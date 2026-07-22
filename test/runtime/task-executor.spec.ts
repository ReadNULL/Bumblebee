import { describe, expect, it } from "vitest";

import {
  abortableSleep,
  ERROR_CODES,
  type LogRecord,
  StructuredLogger,
  TraceContext,
} from "../../src/foundation/index.js";
import { TaskExecutor } from "../../src/runtime/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function createExecutor(concurrencyLimit: number): {
  readonly executor: TaskExecutor;
  readonly records: LogRecord[];
  readonly traceContext: TraceContext;
} {
  const records: LogRecord[] = [];
  const traceContext = new TraceContext();
  const logger = new StructuredLogger({
    clock: () => new Date("2026-07-22T00:00:00.000Z"),
    minLevel: "debug",
    scope: "test",
    sink: (record) => records.push(record),
    traceContext,
  });

  return {
    executor: new TaskExecutor({
      concurrencyLimit,
      logger,
      traceContext,
    }),
    records,
    traceContext,
  };
}

describe("TaskExecutor", () => {
  it("serializes work for one session", async () => {
    const { executor, traceContext } = createExecutor(2);
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let secondStarted = false;

    const first = executor.execute(
      { operationName: "first", sessionKey: "session-a" },
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return "first";
      },
    );
    const second = executor.execute(
      { operationName: "second", sessionKey: "session-a" },
      () => {
        secondStarted = true;
        return "second";
      },
    );

    await firstStarted.promise;
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);

    await executor.dispose();
    traceContext.dispose();
  });

  it("runs different sessions in parallel up to the global limit", async () => {
    const { executor, traceContext } = createExecutor(2);
    const gates = [
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
    ];
    const twoStarted = createDeferred<void>();
    const thirdStarted = createDeferred<void>();
    let active = 0;
    let maximumActive = 0;
    let started = 0;

    const tasks = gates.map((gate, index) =>
      executor.execute(
        {
          operationName: `operation-${index}`,
          sessionKey: `session-${index}`,
        },
        async () => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          if (started === 2) {
            twoStarted.resolve();
          }
          if (started === 3) {
            thirdStarted.resolve();
          }

          await gate.promise;
          active -= 1;
        },
      ),
    );

    await twoStarted.promise;
    expect(maximumActive).toBe(2);
    expect(executor.status.activeOperationCount).toBe(2);
    expect(executor.status.pendingOperationCount).toBe(1);

    gates[0]?.resolve();
    await thirdStarted.promise;
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(tasks);

    expect(maximumActive).toBe(2);
    await executor.dispose();
    traceContext.dispose();
  });

  it("keeps each queued request in its own trace context", async () => {
    const { executor, records, traceContext } = createExecutor(1);
    const releaseFirst = createDeferred<void>();
    const observedTraceIds: string[] = [];

    const first = executor.execute(
      {
        operationName: "first",
        sessionKey: "shared-session",
        traceId: "trace-first",
      },
      async ({ traceId }) => {
        observedTraceIds.push(traceId);
        await releaseFirst.promise;
      },
    );
    const second = executor.execute(
      {
        operationName: "second",
        sessionKey: "shared-session",
        traceId: "trace-second",
      },
      ({ logger, traceId }) => {
        observedTraceIds.push(traceId);
        logger.info("trace observation");
      },
    );

    await Promise.resolve();
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(observedTraceIds).toEqual(["trace-first", "trace-second"]);
    expect(
      records.find((record) => record.message === "trace observation")
        ?.traceId,
    ).toBe("trace-second");

    await executor.dispose();
    traceContext.dispose();
  });

  it("distinguishes timeout and sanitizes unknown failures", async () => {
    const { executor, records, traceContext } = createExecutor(1);

    await expect(
      executor.execute(
        {
          operationName: "slow request",
          sessionKey: "session-a",
          timeoutMs: 10,
          traceId: "trace-timeout",
        },
        ({ signal }) => abortableSleep(1_000, signal),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.TIMEOUT });

    const sourceError = new Error("request used Bearer private-token");
    await expect(
      executor.execute(
        {
          operationName: "failing request",
          sessionKey: "session-b",
          traceId: "trace-failure",
        },
        () => {
          throw sourceError;
        },
      ),
    ).rejects.toMatchObject({
      cause: sourceError,
      code: ERROR_CODES.INTERNAL,
    });

    const timeoutRecord = records.find(
      (record) => record.message === "task timed out",
    );
    const failureRecord = records.find(
      (record) => record.message === "task failed",
    );
    expect(timeoutRecord?.traceId).toBe("trace-timeout");
    expect(failureRecord?.traceId).toBe("trace-failure");
    expect(JSON.stringify(failureRecord)).not.toContain("private-token");

    await executor.dispose();
    traceContext.dispose();
  });

  it("tracks an underlying operation after its caller times out", async () => {
    const { executor, traceContext } = createExecutor(1);
    const operationStarted = createDeferred<void>();
    const releaseOperation = createDeferred<void>();

    const task = executor.execute(
      {
        operationName: "non-cooperative request",
        sessionKey: "session-a",
        timeoutMs: 10,
      },
      async () => {
        operationStarted.resolve();
        await releaseOperation.promise;
      },
    );

    await operationStarted.promise;
    await expect(task).rejects.toMatchObject({ code: ERROR_CODES.TIMEOUT });

    let disposed = false;
    const disposal = executor.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseOperation.resolve();
    await disposal;
    expect(disposed).toBe(true);
    traceContext.dispose();
  });

  it("cancels active work and rejects new work during disposal", async () => {
    const { executor, traceContext } = createExecutor(1);
    const started = createDeferred<void>();
    const task = executor.execute(
      { operationName: "active request", sessionKey: "session-a" },
      async ({ signal }) => {
        started.resolve();
        await abortableSleep(1_000, signal);
      },
    );

    await started.promise;
    const disposal = executor.dispose();

    await expect(task).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    await disposal;
    expect(executor.dispose()).toBe(disposal);
    expect(executor.status).toEqual({
      accepting: false,
      activeOperationCount: 0,
      activeSessionCount: 0,
      pendingOperationCount: 0,
    });
    await expect(
      executor.execute(
        { operationName: "late request", sessionKey: "session-a" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    traceContext.dispose();
  });

  it("validates task identity at the boundary", async () => {
    const { executor, traceContext } = createExecutor(1);

    await expect(
      executor.execute(
        { operationName: " ", sessionKey: "session-a" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    await expect(
      executor.execute(
        { operationName: "valid", sessionKey: " ", timeoutMs: 10 },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });

    await executor.dispose();
    traceContext.dispose();
  });
});
