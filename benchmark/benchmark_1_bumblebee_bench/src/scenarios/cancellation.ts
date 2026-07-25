import { performance } from "node:perf_hooks";

import {
  abortableSleep,
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import type { ScenarioDefinition } from "../runner/index.js";
import {
  captureErrorCode,
  createDeferred,
  createTaskExecutor,
} from "./helpers.js";

export const CANCELLATION_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "cancellation-queued-request",
      domain: "Cancellation",
      async run(context, probe) {
        const { executor, traceContext } = createTaskExecutor(1);
        const blockerStarted = createDeferred<void>();
        const releaseBlocker = createDeferred<void>();
        const queuedController = new AbortController();
        let queuedOperationStarted = false;
        let blocker: Promise<void> | undefined;
        let queued: Promise<void> | undefined;

        try {
          blocker = executor.execute(
            {
              operationName: "blocker",
              sessionKey: "session-a",
              signal: context.signal,
            },
            async () => {
              blockerStarted.resolve();
              await releaseBlocker.promise;
            },
          );
          await blockerStarted.promise;

          queued = executor.execute(
            {
              operationName: "queued",
              sessionKey: "session-b",
              signal: AbortSignal.any([
                context.signal,
                queuedController.signal,
              ]),
            },
            () => {
              queuedOperationStarted = true;
            },
          );
          await Promise.resolve();

          const cancellationStarted = performance.now();
          queuedController.abort(
            new BumblebeeError("benchmark cancellation", {
              code: ERROR_CODES.CANCELLED,
            }),
          );
          const queuedErrorCode = await captureErrorCode(queued);
          const cancellationLatencyMs =
            performance.now() - cancellationStarted;

          probe.check(
            "queued-operation-never-started",
            !queuedOperationStarted,
          );
          probe.check(
            "queued-operation-reports-cancelled",
            queuedErrorCode === ERROR_CODES.CANCELLED,
          );
          probe.check(
            "cancelled-request-leaves-queue",
            executor.status.pendingOperationCount === 0,
          );
          probe.metric(
            "queued_cancellation_latency_ms",
            cancellationLatencyMs,
          );
        } finally {
          releaseBlocker.resolve();
          await Promise.allSettled(
            [blocker, queued].filter(
              (value): value is Promise<void> => value !== undefined,
            ),
          );
          await executor.dispose();
          traceContext.dispose();
        }
      },
    },
    {
      id: "cancellation-timeout-dispose",
      domain: "Cancellation",
      async run(context, probe) {
        const { executor, traceContext } = createTaskExecutor(1);
        let timeoutSignalAborted = false;
        let activeCleanupCompleted = false;
        const activeStarted = createDeferred<void>();
        let active: Promise<void> | undefined;

        try {
          const timed = executor.execute(
            {
              operationName: "timed",
              sessionKey: "timed-session",
              signal: context.signal,
              timeoutMs: 20,
            },
            async ({ signal }) => {
              try {
                await abortableSleep(10_000, signal);
              } finally {
                timeoutSignalAborted = signal.aborted;
              }
            },
          );
          const timeoutCode = await captureErrorCode(timed);
          probe.check(
            "timeout-has-distinct-code",
            timeoutCode === ERROR_CODES.TIMEOUT,
          );
          probe.check(
            "timeout-propagates-signal",
            timeoutSignalAborted,
          );

          active = executor.execute(
            {
              operationName: "active",
              sessionKey: "active-session",
              signal: context.signal,
            },
            async ({ signal }) => {
              activeStarted.resolve();
              try {
                await abortableSleep(10_000, signal);
              } finally {
                await abortableSleep(5);
                activeCleanupCompleted = true;
              }
            },
          );
          await activeStarted.promise;
          const disposal = executor.dispose();
          const activeCode = await captureErrorCode(active);
          await disposal;

          probe.check(
            "dispose-cancels-active-operation",
            activeCode === ERROR_CODES.CANCELLED,
          );
          probe.check(
            "dispose-waits-for-cleanup",
            activeCleanupCompleted,
          );
          probe.check(
            "dispose-drains-runtime",
            executor.status.activeOperationCount === 0 &&
              executor.status.pendingOperationCount === 0 &&
              !executor.status.accepting,
          );
        } finally {
          await executor.dispose();
          if (active !== undefined) {
            await Promise.allSettled([active]);
          }
          traceContext.dispose();
        }
      },
    },
  ]);
