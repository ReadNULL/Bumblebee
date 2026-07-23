import {
  createSubAgentErrorResult,
  SubAgentRunner,
  type SubAgentExecutionRequest,
} from "../../../../src/agents/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../../src/foundation/index.js";
import type { ScenarioDefinition } from "../runner/index.js";

export const SUBAGENT_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "subagent-output-boundary",
      domain: "SubAgent",
      async run(context, probe) {
        let executionRequest: SubAgentExecutionRequest | undefined;
        const runner = new SubAgentRunner(
          {
            async execute(request) {
              executionRequest = request;
              return {
                model: "benchmark/model",
                output: "你".repeat(10),
                usage: {
                  assistantTurns: 2,
                  inputTokens: 100,
                  outputTokens: 10,
                  totalTokens: 110,
                },
              };
            },
          },
          { maxOutputBytes: 7 },
        );

        const result = await runner.run(
          {
            cwd: context.fixtureDirectory,
            task: " inspect the repository ",
          },
          context.signal,
        );

        probe.check(
          "task-input-normalized",
          executionRequest?.task === "inspect the repository",
        );
        probe.check(
          "utf8-output-not-split",
          result.output === "你你" && result.outputBytes === 6,
        );
        probe.check(
          "output-budget-reported",
          result.truncated && result.omittedOutputBytes === 24,
        );
        probe.check(
          "usage-defaults-are-bounded",
          result.usage.totalTokens === 110 &&
            result.usage.cacheReadTokens === 0 &&
            result.usage.cacheWriteTokens === 0,
        );
      },
    },
    {
      id: "subagent-cancellation-errors",
      domain: "SubAgent",
      async run(context, probe) {
        let executorCalls = 0;
        const runner = new SubAgentRunner({
          async execute() {
            executorCalls += 1;
            return { output: "unexpected" };
          },
        });
        const controller = new AbortController();
        controller.abort(
          new BumblebeeError("cancel benchmark request", {
            code: ERROR_CODES.CANCELLED,
          }),
        );

        let cancellationCode: string | undefined;
        try {
          await runner.run(
            {
              cwd: context.fixtureDirectory,
              task: "inspect",
            },
            controller.signal,
          );
        } catch (cause: unknown) {
          cancellationCode = normalizeError(cause).code;
        }

        const timedOut = createSubAgentErrorResult(
          new BumblebeeError("deadline", {
            code: ERROR_CODES.TIMEOUT,
          }),
          1_000,
        );
        const failed = createSubAgentErrorResult(
          new BumblebeeError("internal credential detail", {
            code: ERROR_CODES.UNAVAILABLE,
            userMessage: "模型暂不可用。",
          }),
          1_000,
        );

        probe.check(
          "pre-cancelled-request-skips-executor",
          cancellationCode === ERROR_CODES.CANCELLED &&
            executorCalls === 0,
        );
        probe.check(
          "timeout-remains-distinct",
          timedOut.status === "timed_out" &&
            timedOut.errorCode === ERROR_CODES.TIMEOUT,
        );
        probe.check(
          "failure-uses-approved-message",
          failed.status === "failed" &&
            failed.message === "模型暂不可用。",
        );
        probe.check(
          "failure-hides-internal-detail",
          !JSON.stringify(failed).includes("credential"),
        );
      },
    },
  ]);
