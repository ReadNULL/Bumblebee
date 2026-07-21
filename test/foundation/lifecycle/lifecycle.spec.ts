import { describe, expect, it, vi } from "vitest";

import { abortableSleep } from "../../../src/foundation/cancellation/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";
import {
  Lifecycle,
  LIFECYCLE_STATES,
  type LifecycleContext,
} from "../../../src/foundation/lifecycle/index.js";

describe("Lifecycle", () => {
  it("initializes asynchronously and records acquired resources", async () => {
    const lifecycle = new Lifecycle();
    const cleanup = vi.fn();
    const setup = vi.fn((context: LifecycleContext) => {
      expect(context.signal.aborted).toBe(false);
      context.defer("resource", cleanup);
    });

    const initialization = lifecycle.initialize(setup);
    expect(setup).not.toHaveBeenCalled();

    await initialization;
    expect(setup).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.READY);
    expect(lifecycle.cleanupCount).toBe(1);
    expect(lifecycle.failure).toBeUndefined();

    await lifecycle.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("disposes resources in LIFO order exactly once", async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    await lifecycle.initialize((context) => {
      context.defer("database", () => {
        order.push("database");
      });
      context.defer("channel", () => {
        order.push("channel");
      });
      context.defer("server", () => {
        order.push("server");
      });
    });

    const first = lifecycle.dispose();
    const second = lifecycle.dispose();

    expect(second).toBe(first);
    await first;
    expect(order).toEqual(["server", "channel", "database"]);
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
    expect(lifecycle.cleanupCount).toBe(0);
    expect(lifecycle.dispose()).toBe(first);
  });

  it("aborts the lifecycle signal before normal cleanup", async () => {
    const lifecycle = new Lifecycle();
    let lifecycleSignal: AbortSignal | undefined;
    let abortedDuringCleanup = false;
    await lifecycle.initialize((context) => {
      lifecycleSignal = context.signal;
      context.defer("background-task", () => {
        abortedDuringCleanup = context.signal.aborted;
      });
    });

    expect(lifecycleSignal?.aborted).toBe(false);
    await lifecycle.dispose();

    expect(abortedDuringCleanup).toBe(true);
    expect(lifecycleSignal?.reason).toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
  });

  it("rolls back initialized resources and preserves the setup error", async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    const setupFailure = new Error("channel startup failed");
    const initialization = lifecycle.initialize((context) => {
      context.defer("config", () => {
        order.push("config");
      });
      context.defer("logger", () => {
        order.push("logger");
      });
      throw setupFailure;
    });
    const result = initialization.catch((error: unknown) => error);

    await expect(result).resolves.toBe(setupFailure);
    expect(order).toEqual(["logger", "config"]);
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);
    expect(lifecycle.failure).toBe(setupFailure);
    expect(lifecycle.cleanupCount).toBe(0);

    await lifecycle.dispose();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
  });

  it("reports both initialization and rollback failures", async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    const setupFailure = new Error("setup failed");
    const cleanupFailure = new Error("config cleanup failed");
    const initialization = lifecycle.initialize((context) => {
      context.defer("config", () => {
        order.push("config");
        throw cleanupFailure;
      });
      context.defer("logger", () => {
        order.push("logger");
      });
      throw setupFailure;
    });
    const result = initialization.catch((error: unknown) => error);

    const error = await result;
    expect(error).toBeInstanceOf(BumblebeeError);
    expect(error).toMatchObject({
      code: ERROR_CODES.INTERNAL,
      context: { phase: "rollback", resources: ["config"] },
    });
    expect((error as BumblebeeError).cause).toBeInstanceOf(AggregateError);
    expect(order).toEqual(["logger", "config"]);
    expect(lifecycle.failure).toBe(error);
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);

    await expect(lifecycle.dispose()).rejects.toMatchObject({
      code: ERROR_CODES.INTERNAL,
      context: { phase: "rollback", resources: ["config"] },
    });
  });

  it("attempts every cleanup before reporting disposal failures", async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    await lifecycle.initialize((context) => {
      context.defer("first", () => {
        order.push("first");
        throw new Error("first failed");
      });
      context.defer("second", () => {
        order.push("second");
      });
      context.defer("third", () => {
        order.push("third");
        throw new Error("third failed");
      });
    });

    const first = lifecycle.dispose();
    const result = first.catch((error: unknown) => error);
    const second = lifecycle.dispose();
    expect(second).toBe(first);

    const error = await result;
    expect(error).toMatchObject({
      code: ERROR_CODES.INTERNAL,
      context: { phase: "dispose", resources: ["third", "first"] },
    });
    expect(order).toEqual(["third", "second", "first"]);
    expect(lifecycle.cleanupCount).toBe(0);
    expect(lifecycle.failure).toBe(error);
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);
    expect(lifecycle.dispose()).toBe(first);
  });

  it("keeps the lifecycle idle when initialization is pre-cancelled", async () => {
    const lifecycle = new Lifecycle();
    const controller = new AbortController();
    const timeout = new BumblebeeError("startup deadline", {
      code: ERROR_CODES.TIMEOUT,
    });
    const setup = vi.fn();
    controller.abort(timeout);

    await expect(
      lifecycle.initialize(setup, { signal: controller.signal }),
    ).rejects.toBe(timeout);
    expect(setup).not.toHaveBeenCalled();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.IDLE);

    await lifecycle.initialize(() => {});
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.READY);
    await lifecycle.dispose();
  });

  it("propagates parent cancellation and rolls back", async () => {
    const lifecycle = new Lifecycle();
    const controller = new AbortController();
    const cleanup = vi.fn();
    const initialization = lifecycle.initialize(
      async (context) => {
        context.defer("resource", cleanup);
        await abortableSleep(10_000, context.signal);
      },
      { signal: controller.signal },
    );
    const result = initialization.catch((error: unknown) => error);

    await Promise.resolve();
    controller.abort("application shutdown");

    await expect(result).resolves.toMatchObject({
      cause: "application shutdown",
      code: ERROR_CODES.CANCELLED,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);
  });

  it("cancels initialization when dispose is requested", async () => {
    const lifecycle = new Lifecycle();
    const cleanup = vi.fn();
    let setupSignal: AbortSignal | undefined;
    const initialization = lifecycle.initialize(async (context) => {
      setupSignal = context.signal;
      context.defer("resource", cleanup);
      await abortableSleep(10_000, context.signal);
    });
    const initializationResult = initialization.catch(
      (error: unknown) => error,
    );

    await Promise.resolve();
    const firstDispose = lifecycle.dispose();
    const secondDispose = lifecycle.dispose();

    expect(secondDispose).toBe(firstDispose);
    await expect(initializationResult).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    await firstDispose;
    expect(setupSignal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
  });

  it("does not start setup when disposed before its async start", async () => {
    const lifecycle = new Lifecycle();
    const setup = vi.fn();
    const initialization = lifecycle.initialize(setup);
    const initializationResult = initialization.catch(
      (error: unknown) => error,
    );

    const disposal = lifecycle.dispose();

    await expect(initializationResult).resolves.toMatchObject({
      code: ERROR_CODES.CANCELLED,
    });
    await disposal;
    expect(setup).not.toHaveBeenCalled();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
  });

  it("rejects cleanup registration after initialization", async () => {
    const lifecycle = new Lifecycle();
    let capturedContext: LifecycleContext | undefined;
    await lifecycle.initialize((context) => {
      capturedContext = context;
    });

    expect(() => capturedContext?.defer("late", () => {})).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.CONFLICT }),
    );
    await lifecycle.dispose();
  });

  it("rolls back when cleanup registration is invalid", async () => {
    const lifecycle = new Lifecycle();
    const cleanup = vi.fn();
    const initialization = lifecycle.initialize((context) => {
      context.defer("valid", cleanup);
      context.defer("  ", () => {});
    });
    const result = initialization.catch((error: unknown) => error);

    await expect(result).resolves.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.FAILED);
  });

  it("rejects duplicate initialization", async () => {
    const lifecycle = new Lifecycle();
    const duplicateSetup = vi.fn();
    await lifecycle.initialize(() => {});

    await expect(lifecycle.initialize(duplicateSetup)).rejects.toMatchObject({
      code: ERROR_CODES.CONFLICT,
      context: { operation: "initialize", state: "ready" },
    });
    expect(duplicateSetup).not.toHaveBeenCalled();
    await lifecycle.dispose();
  });

  it("allows dispose before initialization and remains terminal", async () => {
    const lifecycle = new Lifecycle();
    const first = lifecycle.dispose();

    await first;
    expect(lifecycle.state).toBe(LIFECYCLE_STATES.DISPOSED);
    expect(lifecycle.dispose()).toBe(first);
    await expect(lifecycle.initialize(() => {})).rejects.toMatchObject({
      code: ERROR_CODES.CONFLICT,
    });
  });
});
