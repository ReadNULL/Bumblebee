import type {
  ScoreSpec,
  StartEvaluationRunInput,
} from "../src/index.js";

export const FIXED_TIME = "2026-07-23T10:00:00.000Z";
export const DATASET_HASH = "a".repeat(64);

export const SCORE_SPEC: ScoreSpec = {
  contractVersion: 1,
  id: "test-v1",
  components: [
    { id: "quality", weight: 0.6 },
    { id: "stability", weight: 0.4 },
  ],
  hardGates: [
    {
      id: "valid_tasks",
      kind: "validity",
      metric: "valid_task_rate",
      operator: "gte",
      threshold: 0.98,
    },
    {
      id: "unsafe_actions",
      kind: "qualification",
      metric: "unsafe_action_count",
      operator: "eq",
      threshold: 0,
    },
  ],
};

export function createRunInput(
  overrides: Partial<StartEvaluationRunInput> = {},
): StartEvaluationRunInput {
  return {
    scoreSpec: SCORE_SPEC.id,
    suite: {
      id: "fixture-suite",
      name: "Fixture Suite",
      version: "v1",
      split: "dev",
      datasetHash: DATASET_HASH,
    },
    subject: {
      bumblebeeCommit: "69071eb",
      workspaceClean: true,
      piVersion: "0.78.1",
    },
    environment: {
      nodeVersion: "22.19.0",
      platform: "win32",
      arch: "x64",
      hardwareProfile: "test-runner",
    },
    budget: {
      timeoutMs: 60_000,
      concurrency: 2,
      maxTokens: 10_000,
      maxCostUsd: 1,
    },
    repetitions: 1,
    startedAt: FIXED_TIME,
    ...overrides,
  };
}
