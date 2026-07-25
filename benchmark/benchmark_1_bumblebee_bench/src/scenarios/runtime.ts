import type { ScenarioDefinition } from "../runner/index.js";
import {
  arraysEqual,
  createDeferred,
  createTaskExecutor,
} from "./helpers.js";

export const RUNTIME_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "runtime-session-order",
      domain: "Runtime",
      async run(context, probe) {
        const { executor, traceContext } = createTaskExecutor(2);
        const firstStarted = createDeferred<void>();
        const releaseFirst = createDeferred<void>();
        const order: string[] = [];
        const operations: Promise<unknown>[] = [];

        try {
          const first = executor.execute(
            {
              operationName: "first",
              sessionKey: "shared-session",
              signal: context.signal,
            },
            async () => {
              order.push("first-start");
              firstStarted.resolve();
              await releaseFirst.promise;
              order.push("first-end");
            },
          );
          const second = executor.execute(
            {
              operationName: "second",
              sessionKey: "shared-session",
              signal: context.signal,
            },
            () => {
              order.push("second-start");
              order.push("second-end");
            },
          );
          operations.push(first, second);

          await firstStarted.promise;
          await Promise.resolve();
          probe.check(
            "second-waits-for-first",
            !order.includes("second-start"),
          );

          releaseFirst.resolve();
          await Promise.all(operations);
          const expected = [
            "first-start",
            "first-end",
            "second-start",
            "second-end",
          ];
          const ordered = arraysEqual(order, expected);
          probe.check("same-session-order-preserved", ordered);
          probe.check(
            "runtime-queue-drained",
            executor.status.activeOperationCount === 0 &&
              executor.status.pendingOperationCount === 0,
          );
          probe.metric(
            "session_order_violation_count",
            ordered ? 0 : 1,
          );
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled(operations);
          await executor.dispose();
          traceContext.dispose();
        }
      },
    },
    {
      id: "runtime-global-concurrency",
      domain: "Runtime",
      async run(context, probe) {
        const { executor, traceContext } = createTaskExecutor(2);
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
        const operations: Promise<void>[] = [];

        try {
          for (const [index, gate] of gates.entries()) {
            operations.push(executor.execute(
              {
                operationName: `parallel-${index}`,
                sessionKey: `session-${index}`,
                signal: context.signal,
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
                try {
                  await gate.promise;
                } finally {
                  active -= 1;
                }
              },
            ));
          }

          await twoStarted.promise;
          probe.check(
            "two-sessions-run-concurrently",
            executor.status.activeOperationCount === 2,
          );
          probe.check(
            "third-session-remains-queued",
            executor.status.pendingOperationCount === 1,
          );

          gates[0]?.resolve();
          await thirdStarted.promise;
          for (const gate of gates) {
            gate.resolve();
          }
          await Promise.all(operations);

          probe.check("global-limit-respected", maximumActive === 2);
          probe.check("all-sessions-completed", started === 3);
          probe.metric("maximum_runtime_concurrency", maximumActive);
        } finally {
          for (const gate of gates) {
            gate.resolve();
          }
          await Promise.allSettled(operations);
          await executor.dispose();
          traceContext.dispose();
        }
      },
    },
  ]);
