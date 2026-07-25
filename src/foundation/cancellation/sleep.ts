import { getAbortError, throwIfAborted } from "./abort.js";
import { validateDurationMs } from "./duration.js";

/** 可被 AbortSignal 立即打断的等待，用于退避和轮询间隔。 */
export async function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const validatedDelayMs = validateDurationMs(delayMs, "delayMs", true);
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onElapsed = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(getAbortError(signal as AbortSignal));
    };
    const timer = setTimeout(onElapsed, validatedDelayMs);

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });

      // 覆盖初次检查与监听器注册之间发生取消的极小竞态窗口。
      if (signal.aborted) {
        onAbort();
      }
    }
  });
}
