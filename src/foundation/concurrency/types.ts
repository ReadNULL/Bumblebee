export interface WaitOptions {
  readonly signal?: AbortSignal;
}

export type ConcurrentOperation<T> = (
  signal: AbortSignal | undefined,
) => PromiseLike<T> | T;
