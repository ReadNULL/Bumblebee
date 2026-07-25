import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  LIFECYCLE_STATES,
  type LogRecord,
} from "../../src/foundation/index.js";
import { BumblebeeRuntime } from "../../src/runtime/index.js";

describe("BumblebeeRuntime", () => {
  it("owns initialization, task execution, and disposal", async () => {
    const records: LogRecord[] = [];
    const runtime = new BumblebeeRuntime({
      clock: () => new Date("2026-07-22T00:00:00.000Z"),
      concurrencyLimit: 2,
      logSink: (record) => records.push(record),
      minLogLevel: "debug",
    });

    await expect(
      runtime.execute(
        { operationName: "before init", sessionKey: "session-a" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });

    await runtime.initialize();
    expect(runtime.status).toMatchObject({
      state: LIFECYCLE_STATES.READY,
      tasks: { accepting: true },
    });

    await expect(
      runtime.execute(
        {
          operationName: "echo",
          sessionKey: "session-a",
          traceId: "runtime-trace",
        },
        ({ traceId }) => `result:${traceId}`,
      ),
    ).resolves.toBe("result:runtime-trace");
    expect(records[0]).toMatchObject({
      fields: { concurrencyLimit: 2 },
      message: "runtime initialized",
      scope: "bumblebee",
    });

    const disposal = runtime.dispose();
    expect(runtime.dispose()).toBe(disposal);
    await disposal;
    expect(runtime.status).toMatchObject({
      state: LIFECYCLE_STATES.DISPOSED,
      tasks: { accepting: false },
    });
    await expect(
      runtime.execute(
        { operationName: "after dispose", sessionKey: "session-a" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it("rolls back resources when runtime construction fails", async () => {
    const runtime = new BumblebeeRuntime({ concurrencyLimit: 0 });

    await expect(runtime.initialize()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(runtime.status).toEqual({ state: LIFECYCLE_STATES.FAILED });

    await runtime.dispose();
    expect(runtime.status.state).toBe(LIFECYCLE_STATES.DISPOSED);
  });
});
