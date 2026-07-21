import { describe, expect, it } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";
import {
  createJsonLineSink,
  REDACTED_VALUE,
  StructuredLogger,
  TraceContext,
  type LogRecord,
} from "../../../src/foundation/logging/index.js";

const FIXED_TIME = new Date("2026-07-21T12:00:00.000Z");

describe("StructuredLogger", () => {
  it("emits a deterministic, traced, and redacted record", () => {
    const records: LogRecord[] = [];
    const traceContext = new TraceContext();
    const logger = new StructuredLogger({
      clock: () => FIXED_TIME,
      fields: { application: "bumblebee", apiKey: "base-secret" },
      minLevel: "debug",
      sanitize: { additionalSensitiveKeys: ["sessionId"] },
      scope: "foundation",
      sink: (record) => records.push(record),
      traceContext,
    });
    const error = new BumblebeeError("provider token=error-secret failed", {
      code: ERROR_CODES.UNAVAILABLE,
      retryable: true,
    });

    traceContext.run(() => {
      logger.error("request used Bearer message-secret", {
        error,
        fields: {
          channel: "feishu",
          password: "field-secret",
          sessionId: "session-secret",
        },
      });
    }, "trace-123");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      timestamp: "2026-07-21T12:00:00.000Z",
      level: "error",
      message: "request used Bearer [REDACTED]",
      scope: "foundation",
      traceId: "trace-123",
      fields: {
        application: "bumblebee",
        apiKey: REDACTED_VALUE,
        channel: "feishu",
        password: REDACTED_VALUE,
        sessionId: REDACTED_VALUE,
      },
      error: {
        name: "BumblebeeError",
        message: "provider token=[REDACTED] failed",
        code: ERROR_CODES.UNAVAILABLE,
        retryable: true,
      },
    });
  });

  it("filters records below the configured level", () => {
    const records: LogRecord[] = [];
    const logger = new StructuredLogger({
      clock: () => FIXED_TIME,
      minLevel: "warn",
      sink: (record) => records.push(record),
      traceContext: new TraceContext(),
    });

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(records.map((record) => record.level)).toEqual(["warn", "error"]);
  });

  it("creates scoped child loggers with predictable field precedence", () => {
    const records: LogRecord[] = [];
    const root = new StructuredLogger({
      clock: () => FIXED_TIME,
      fields: { component: "root", stable: true },
      scope: "app",
      sink: (record) => records.push(record),
      traceContext: new TraceContext(),
    });
    const child = root.child("worker", { component: "child", worker: 1 });

    child.info("started", {
      fields: { component: "call", attempt: 2 },
    });

    expect(records[0]).toMatchObject({
      scope: "app.worker",
      fields: {
        component: "call",
        stable: true,
        worker: 1,
        attempt: 2,
      },
    });
  });
});

describe("createJsonLineSink", () => {
  it("writes one newline-delimited JSON object per record", () => {
    let output = "";
    const sink = createJsonLineSink((line) => {
      output += line;
    });

    sink({
      timestamp: "2026-07-21T12:00:00.000Z",
      level: "info",
      message: "ready",
    });

    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output.trim())).toEqual({
      timestamp: "2026-07-21T12:00:00.000Z",
      level: "info",
      message: "ready",
    });
  });
});
