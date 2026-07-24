import {
  ASSURANCE_CRITIC_MARKER,
  TaskAssurance,
  type AssuranceToolCall,
} from "../../../../src/agents/index.js";

export type AssuranceSuiteSplit = "dev" | "holdout";

export interface AssuranceScenarioResult {
  readonly id: string;
  readonly split: AssuranceSuiteSplit;
  readonly passed: boolean;
  readonly message: string;
}

export interface AssuranceSuiteReport {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly results: readonly AssuranceScenarioResult[];
}

interface AssuranceScenario {
  readonly id: string;
  readonly split: AssuranceSuiteSplit;
  readonly run: () => void;
}

/**
 * A task-agnostic regression set for assurance policy changes. Holdout cases
 * are kept separate so a fix can be checked without tuning against every case.
 */
export function runAssuranceDevelopmentSuite(
  split: AssuranceSuiteSplit | "all" = "all",
): AssuranceSuiteReport {
  const results = SCENARIOS
    .filter((scenario) =>
      split === "all" || scenario.split === split
    )
    .map(runScenario);
  const passed = results.filter((result) => result.passed).length;
  return Object.freeze({
    passed,
    failed: results.length - passed,
    total: results.length,
    results: Object.freeze(results),
  });
}

const SCENARIOS: readonly AssuranceScenario[] = [
  {
    id: "dev-unresolved-strong-check",
    split: "dev",
    run() {
      const assurance = changedTask("dev-1", "Update the parser.");
      complete(assurance, "dev-1", {
        toolCallId: "failed",
        toolName: "bash",
        input: { command: "pytest tests -q" },
      }, true);
      complete(assurance, "dev-1", {
        toolCallId: "smoke",
        toolName: "bash",
        input: { command: "python -c \"print('ok')\"" },
      });
      assert(
        assurance.reviewCompletion("dev-1").shouldFollowUp,
        "unresolved repository failure was not retained",
      );
    },
  },
  {
    id: "dev-exact-rerun-clears",
    split: "dev",
    run() {
      const assurance = changedTask("dev-2", "Update the parser.");
      const call = {
        toolCallId: "failed",
        toolName: "bash",
        input: { command: "pytest tests -q" },
      };
      complete(assurance, "dev-2", call, true);
      complete(assurance, "dev-2", {
        ...call,
        toolCallId: "passed",
      });
      assert(
        assurance.getSnapshot("dev-2")
          ?.unresolvedVerificationKeys.length === 0,
        "successful exact rerun did not clear its failure",
      );
    },
  },
  {
    id: "dev-contract-critic",
    split: "dev",
    run() {
      const assurance = changedTask(
        "dev-3",
        "Output JSON with fields `id` and `status`. The final line must end with a newline.",
      );
      complete(assurance, "dev-3", {
        toolCallId: "tests",
        toolName: "bash",
        input: { command: "npm test" },
      });
      assert(
        assurance.reviewCompletion("dev-3").reasons.some(
          (reason) => reason.includes("read-only review"),
        ),
        "contract-rich change did not require independent review",
      );
    },
  },
  {
    id: "dev-preserve-before-recovery",
    split: "dev",
    run() {
      const assurance = new TaskAssurance();
      assurance.beginTask(
        "dev-4",
        "Recover `/data/source.db` without changing the original.",
      );
      assert(
        assurance.beforeTool("dev-4", {
          toolCallId: "open",
          toolName: "bash",
          input: { command: "sqlite3 /data/source.db '.tables'" },
        }).block === true,
        "recovery operation was not blocked before preservation",
      );
    },
  },
  {
    id: "holdout-narrow-check-cannot-clear",
    split: "holdout",
    run() {
      const assurance = changedTask("holdout-1", "Update the service.");
      complete(assurance, "holdout-1", {
        toolCallId: "full",
        toolName: "bash",
        input: { command: "pytest tests -q" },
      }, true);
      complete(assurance, "holdout-1", {
        toolCallId: "narrow",
        toolName: "bash",
        input: { command: "pytest tests/test_health.py -q" },
      });
      assert(
        assurance.getSnapshot("holdout-1")
          ?.unresolvedVerificationKeys.length === 1,
        "narrow test incorrectly cleared the broader failure",
      );
    },
  },
  {
    id: "holdout-build-cannot-clear-tests",
    split: "holdout",
    run() {
      const assurance = changedTask("holdout-2", "Update the package.");
      complete(assurance, "holdout-2", {
        toolCallId: "test",
        toolName: "bash",
        input: { command: "npm test" },
      }, true);
      complete(assurance, "holdout-2", {
        toolCallId: "lint",
        toolName: "bash",
        input: { command: "npm run lint" },
      });
      assert(
        assurance.reviewCompletion("holdout-2").shouldFollowUp,
        "build/static evidence erased a test failure",
      );
    },
  },
  {
    id: "holdout-read-only-task-needs-no-evidence-turn",
    split: "holdout",
    run() {
      const assurance = new TaskAssurance();
      assurance.beginTask("holdout-3", "Explain the current API.");
      assert(
        !assurance.reviewCompletion("holdout-3").shouldFollowUp,
        "read-only task received an unnecessary follow-up",
      );
    },
  },
  {
    id: "holdout-critic-cost-recorded",
    split: "holdout",
    run() {
      const assurance = changedTask(
        "holdout-4",
        "Keep fields `key` and `value` in the public schema.",
      );
      complete(assurance, "holdout-4", {
        toolCallId: "tests",
        toolName: "bash",
        input: { command: "pytest -q" },
      });
      complete(assurance, "holdout-4", {
        toolCallId: "critic",
        toolName: "delegate_task",
        input: {
          task: `${ASSURANCE_CRITIC_MARKER} review the schema`,
        },
      }, false, { usage: { costUsd: 0.02 } });
      const snapshot = assurance.getSnapshot("holdout-4");
      assert(
        snapshot?.criticRuns === 1 &&
          snapshot.criticCostUsd === 0.02,
        "critic run or cost was not recorded",
      );
      assert(
        assurance.reviewCompletion("holdout-4").reasons.length === 0,
        "verified and reviewed task retained an evidence gap",
      );
    },
  },
];

function changedTask(
  sessionId: string,
  prompt: string,
): TaskAssurance {
  const assurance = new TaskAssurance();
  assurance.beginTask(sessionId, prompt);
  complete(assurance, sessionId, {
    toolCallId: "change",
    toolName: "edit",
    input: { path: "src/example.ts" },
  });
  return assurance;
}

function complete(
  assurance: TaskAssurance,
  sessionId: string,
  call: AssuranceToolCall,
  isError = false,
  details?: unknown,
): void {
  const decision = assurance.beforeTool(sessionId, call);
  assert(!decision.block, decision.reason ?? "tool call was blocked");
  assurance.afterTool(sessionId, {
    ...(details === undefined ? {} : { details }),
    isError,
    toolCallId: call.toolCallId,
  });
}

function runScenario(
  scenario: AssuranceScenario,
): AssuranceScenarioResult {
  try {
    scenario.run();
    return Object.freeze({
      id: scenario.id,
      split: scenario.split,
      passed: true,
      message: "passed",
    });
  } catch (cause: unknown) {
    return Object.freeze({
      id: scenario.id,
      split: scenario.split,
      passed: false,
      message:
        cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
