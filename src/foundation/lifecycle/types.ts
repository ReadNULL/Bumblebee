export const LIFECYCLE_STATES = {
  IDLE: "idle",
  INITIALIZING: "initializing",
  READY: "ready",
  ROLLING_BACK: "rolling-back",
  DISPOSING: "disposing",
  DISPOSED: "disposed",
  FAILED: "failed",
} as const;

export type LifecycleState =
  (typeof LIFECYCLE_STATES)[keyof typeof LIFECYCLE_STATES];

export type LifecycleCleanup = () => PromiseLike<void> | void;

export interface LifecycleContext {
  readonly signal: AbortSignal;
  defer(name: string, cleanup: LifecycleCleanup): void;
}

export interface LifecycleInitializeOptions {
  readonly signal?: AbortSignal;
}

export type LifecycleSetup = (
  context: LifecycleContext,
) => PromiseLike<void> | void;
