import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";
import {
  getAbortError,
  throwIfAborted,
} from "../cancellation/index.js";
import {
  CleanupStack,
  type CleanupFailure,
} from "./cleanup-stack.js";
import {
  LIFECYCLE_STATES,
  type LifecycleCleanup,
  type LifecycleContext,
  type LifecycleInitializeOptions,
  type LifecycleSetup,
  type LifecycleState,
} from "./types.js";

type CleanupPhase = "dispose" | "rollback";

/** 管理一次初始化作用域，以及其中资源的逆序回滚和释放。 */
export class Lifecycle {
  private readonly cleanups = new CleanupStack();
  private cleanupFailure: BumblebeeError | undefined;
  private controller: AbortController | undefined;
  private disposalPromise: Promise<void> | undefined;
  private failureValue: unknown;
  private initializationPromise: Promise<void> | undefined;
  private registrationOpen = false;
  private stateValue: LifecycleState = LIFECYCLE_STATES.IDLE;

  get cleanupCount(): number {
    return this.cleanups.size;
  }

  get failure(): unknown {
    return this.failureValue;
  }

  get state(): LifecycleState {
    return this.stateValue;
  }

  initialize(
    setup: LifecycleSetup,
    options: LifecycleInitializeOptions = {},
  ): Promise<void> {
    if (this.stateValue !== LIFECYCLE_STATES.IDLE) {
      return Promise.reject(this.createConflictError("initialize"));
    }

    if (typeof setup !== "function") {
      return Promise.reject(
        new BumblebeeError("Lifecycle setup must be a function", {
          code: ERROR_CODES.INVALID_INPUT,
        }),
      );
    }

    if (options.signal?.aborted) {
      return Promise.reject(getAbortError(options.signal));
    }

    const controller = new AbortController();
    this.controller = controller;
    this.stateValue = LIFECYCLE_STATES.INITIALIZING;
    this.registrationOpen = true;

    const removeParentListener = this.linkParentSignal(
      options.signal,
      controller,
    );
    const context = Object.freeze<LifecycleContext>({
      defer: (name, cleanup) => this.defer(name, cleanup),
      signal: controller.signal,
    });
    const promise = this.runInitialization(
      setup,
      context,
      controller,
      removeParentListener,
    );
    this.initializationPromise = promise;
    return promise;
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== undefined) {
      return this.disposalPromise;
    }

    switch (this.stateValue) {
      case LIFECYCLE_STATES.IDLE: {
        this.stateValue = LIFECYCLE_STATES.DISPOSED;
        const promise = Promise.resolve();
        this.disposalPromise = promise;
        return promise;
      }
      case LIFECYCLE_STATES.INITIALIZING:
      case LIFECYCLE_STATES.ROLLING_BACK: {
        if (this.controller !== undefined && !this.controller.signal.aborted) {
          this.controller.abort(
            new BumblebeeError("Lifecycle disposed during initialization", {
              code: ERROR_CODES.CANCELLED,
            }),
          );
        }

        const promise = this.disposeAfterInitialization();
        this.disposalPromise = promise;
        return promise;
      }
      case LIFECYCLE_STATES.READY: {
        this.abortActiveSignal("Lifecycle disposed");
        this.stateValue = LIFECYCLE_STATES.DISPOSING;
        const promise = this.runDisposal();
        this.disposalPromise = promise;
        return promise;
      }
      case LIFECYCLE_STATES.FAILED: {
        const promise = this.finishFailedLifecycle();
        this.disposalPromise = promise;
        return promise;
      }
      case LIFECYCLE_STATES.DISPOSED:
        return Promise.resolve();
      case LIFECYCLE_STATES.DISPOSING:
      default:
        return Promise.reject(this.createConflictError("dispose"));
    }
  }

  private defer(name: string, cleanup: LifecycleCleanup): void {
    if (
      !this.registrationOpen ||
      this.stateValue !== LIFECYCLE_STATES.INITIALIZING
    ) {
      throw this.createConflictError("register cleanup");
    }

    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (normalizedName.length === 0 || typeof cleanup !== "function") {
      throw new BumblebeeError(
        "Cleanup name must be non-empty and cleanup must be a function",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { name },
        },
      );
    }

    this.cleanups.push(normalizedName, cleanup);
  }

  private async runInitialization(
    setup: LifecycleSetup,
    context: LifecycleContext,
    controller: AbortController,
    removeParentListener: () => void,
  ): Promise<void> {
    try {
      // 防止 initialize() 在返回 Promise 前同步调用用户代码。
      await Promise.resolve();
      throwIfAborted(controller.signal);
      await setup(context);
      throwIfAborted(controller.signal);
      this.registrationOpen = false;
      this.stateValue = LIFECYCLE_STATES.READY;
    } catch (initializationError: unknown) {
      this.registrationOpen = false;
      if (!controller.signal.aborted) {
        controller.abort(
          new BumblebeeError("Lifecycle initialization failed", {
            code: ERROR_CODES.CANCELLED,
            cause: initializationError,
          }),
        );
      }
      this.stateValue = LIFECYCLE_STATES.ROLLING_BACK;
      const rollbackFailure = await this.cleanup("rollback");
      const failure = this.combineInitializationFailure(
        initializationError,
        rollbackFailure,
      );
      this.failureValue = failure;
      this.stateValue = LIFECYCLE_STATES.FAILED;
      throw failure;
    } finally {
      this.registrationOpen = false;
      removeParentListener();
      if (
        this.controller === controller &&
        this.stateValue !== LIFECYCLE_STATES.READY
      ) {
        this.controller = undefined;
      }
    }
  }

  private async runDisposal(): Promise<void> {
    // 先让 disposePromise 完成赋值，防止清理函数重入 dispose()。
    await Promise.resolve();
    try {
      const failure = await this.cleanup("dispose");

      if (failure !== undefined) {
        this.failureValue = failure;
        this.stateValue = LIFECYCLE_STATES.FAILED;
        throw failure;
      }

      this.stateValue = LIFECYCLE_STATES.DISPOSED;
    } finally {
      this.controller = undefined;
    }
  }

  private async disposeAfterInitialization(): Promise<void> {
    const initialization = this.initializationPromise;
    if (initialization === undefined) {
      throw new BumblebeeError("Lifecycle initialization promise is missing", {
        code: ERROR_CODES.INTERNAL,
      });
    }

    const outcome = await initialization.then(
      () => ({ kind: "succeeded" as const }),
      (error: unknown) => ({ error, kind: "failed" as const }),
    );
    if (outcome.kind === "failed" && this.failureValue === undefined) {
      this.failureValue = outcome.error;
    }

    if (this.cleanups.size > 0) {
      this.stateValue = LIFECYCLE_STATES.DISPOSING;
      const failure = await this.cleanup("dispose");
      if (failure !== undefined) {
        this.failureValue = failure;
        this.stateValue = LIFECYCLE_STATES.FAILED;
        throw failure;
      }
    }

    if (this.cleanupFailure !== undefined) {
      this.stateValue = LIFECYCLE_STATES.FAILED;
      throw this.cleanupFailure;
    }

    this.stateValue = LIFECYCLE_STATES.DISPOSED;
  }

  private async finishFailedLifecycle(): Promise<void> {
    await Promise.resolve();

    if (this.cleanupFailure !== undefined) {
      throw this.cleanupFailure;
    }

    this.stateValue = LIFECYCLE_STATES.DISPOSED;
  }

  private async cleanup(
    phase: CleanupPhase,
  ): Promise<BumblebeeError | undefined> {
    const failures = await this.cleanups.disposeAll();
    const failure = this.createCleanupFailure(phase, failures);

    if (failure !== undefined) {
      this.cleanupFailure = failure;
    }

    return failure;
  }

  private createCleanupFailure(
    phase: CleanupPhase,
    failures: CleanupFailure[],
  ): BumblebeeError | undefined {
    if (failures.length === 0) {
      return undefined;
    }

    const resources = failures.map((failure) => failure.name);
    return new BumblebeeError(
      `Lifecycle ${phase} failed for ${failures.length} cleanup operation(s)`,
      {
        code: ERROR_CODES.INTERNAL,
        cause: new AggregateError(
          failures.map((failure) => failure.error),
          `Lifecycle ${phase} cleanup failed`,
        ),
        context: { phase, resources },
      },
    );
  }

  private combineInitializationFailure(
    initializationError: unknown,
    rollbackFailure: BumblebeeError | undefined,
  ): unknown {
    if (rollbackFailure === undefined) {
      return initializationError;
    }

    return new BumblebeeError(
      "Lifecycle initialization failed and rollback was incomplete",
      {
        code: ERROR_CODES.INTERNAL,
        cause: new AggregateError(
          [initializationError, rollbackFailure],
          "Lifecycle initialization and rollback failed",
        ),
        ...(rollbackFailure.context === undefined
          ? {}
          : { context: rollbackFailure.context }),
      },
    );
  }

  private linkParentSignal(
    signal: AbortSignal | undefined,
    controller: AbortController,
  ): () => void {
    if (signal === undefined) {
      return () => {};
    }

    const onAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(getAbortError(signal));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    }

    return () => {
      signal.removeEventListener("abort", onAbort);
    };
  }

  private createConflictError(operation: string): BumblebeeError {
    return new BumblebeeError(
      `Cannot ${operation} lifecycle while state is ${this.stateValue}`,
      {
        code: ERROR_CODES.CONFLICT,
        context: { operation, state: this.stateValue },
      },
    );
  }

  private abortActiveSignal(message: string): void {
    if (this.controller !== undefined && !this.controller.signal.aborted) {
      this.controller.abort(
        new BumblebeeError(message, {
          code: ERROR_CODES.CANCELLED,
        }),
      );
    }
  }
}
