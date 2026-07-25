import { describe, expect, it } from "vitest";

import { aggregateTerminalBench } from "../../src/index.js";
import {
  createCalibratedBudget,
  createNormalizedFixtureJob,
  createTestManifest,
} from "../fixtures.js";

describe("Terminal-Bench scoring", () => {
  it("uses official reward and baseline-relative efficiency", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      costUsd: 4,
      agentDurationMs: 4_000,
    });
    const budget = createCalibratedBudget(manifest);
    const result = aggregateTerminalBench(
      manifest,
      job,
      budget,
    );

    expect(result.gateEvaluation.status).toBe("qualified");
    expect(result.componentScores).toEqual({
      OfficialReward: 100,
      CostEfficiency: 50,
      LatencyEfficiency: 50,
      Stability: 100,
    });
    expect(result.score.score).toBe(92.5);
  });

  it("records raw components but publishes no score without a budget", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest);
    const result = aggregateTerminalBench(manifest, job);

    expect(result.gateEvaluation.status).toBe("not-qualified");
    expect(result.metrics.efficiency_budget_coverage).toBe(0);
    expect(result.componentScores.OfficialReward).toBe(100);
    expect(result.score.score).toBeNull();
  });

  it("assigns zero efficiency to failed tasks", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      rewards: [0, 1, 1, 1],
    });
    const result = aggregateTerminalBench(
      manifest,
      job,
      createCalibratedBudget(manifest),
    );

    expect(result.componentScores.OfficialReward).toBe(75);
    expect(result.componentScores.CostEfficiency).toBe(75);
    expect(result.componentScores.LatencyEfficiency).toBe(75);
  });

  it("invalidates a budget calibrated with another thinking level", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest);
    const budget = {
      ...createCalibratedBudget(manifest),
      baselineIdentity: {
        agentName: "pi-baseline",
        agentVersion: manifest.agents.piVersion,
        modelProvider: "openai",
        modelName: "gpt-fixture",
        thinkingLevel: "low",
      },
    };
    const result = aggregateTerminalBench(
      manifest,
      job,
      budget,
    );

    expect(result.metrics.baseline_model_identity_match).toBe(0);
    expect(result.gateEvaluation.status).toBe("invalid");
    expect(result.score.score).toBeNull();
  });

  it("rejects a different sample with the same task count", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      taskIds: ["task-alpha", "task-gamma"],
    });
    const result = aggregateTerminalBench(manifest, job);

    expect(result.metrics.task_coverage_rate).toBe(0.5);
    expect(result.metrics.task_selection_match).toBe(0);
    expect(result.metrics.unexpected_task_count).toBe(1);
    expect(result.gateEvaluation.status).toBe("invalid");
  });
});
