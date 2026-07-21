import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";
import { TraceContext } from "../../../src/foundation/logging/index.js";

describe("TraceContext", () => {
  it("preserves a traceId across await boundaries", async () => {
    const context = new TraceContext();

    await context.run(async () => {
      expect(context.getTraceId()).toBe("trace-1");
      await delay(1);
      expect(context.getTraceId()).toBe("trace-1");
    }, "trace-1");

    expect(context.getTraceId()).toBeUndefined();
  });

  it("isolates concurrent traces", async () => {
    const context = new TraceContext();
    const traceIds = ["trace-a", "trace-b", "trace-c"];

    const results = await Promise.all(
      traceIds.map((traceId, index) =>
        context.run(async () => {
          await delay(traceIds.length - index);
          return context.getTraceId();
        }, traceId),
      ),
    );

    expect(results).toEqual(traceIds);
  });

  it("restores the parent trace after a nested trace completes", () => {
    const context = new TraceContext();

    context.run(() => {
      expect(context.getTraceId()).toBe("parent");
      context.run(() => {
        expect(context.getTraceId()).toBe("child");
      }, "child");
      expect(context.getTraceId()).toBe("parent");
    }, "parent");
  });

  it("generates a traceId and rejects empty identifiers", () => {
    const context = new TraceContext();
    const generated = context.run(() => context.getTraceId());

    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    let caught: unknown;
    try {
      context.run(() => undefined, "   ");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BumblebeeError);
    expect((caught as BumblebeeError).code).toBe(ERROR_CODES.INVALID_INPUT);
  });
});
