import { describe, expect, it } from "vitest";

import {
  calibrateTerminalBenchBudget,
  parseTerminalBenchBudgetManifest,
} from "../../src/index.js";
import {
  createNormalizedFixtureJob,
  createTestManifest,
} from "../fixtures.js";

describe("Terminal-Bench baseline calibration", () => {
  it("uses the per-task median of three complete Pi jobs", () => {
    const manifest = createTestManifest();
    const jobs = [1, 2, 3].map((index) =>
      createNormalizedFixtureJob(manifest, {
        jobId: `baseline-${index}`,
        agentName: "pi-baseline",
        costUsd: index,
        agentDurationMs: index * 1_000,
        omitExtension: true,
      })
    );
    const budget = calibrateTerminalBenchBudget(
      manifest,
      jobs,
      () => new Date("2026-07-23T12:00:00.000Z"),
    );

    expect(budget.sourceJobIds).toEqual([
      "baseline-1",
      "baseline-2",
      "baseline-3",
    ]);
    expect(budget.taskBudgets).toHaveLength(2);
    expect(budget.taskBudgets[0]).toMatchObject({
      costUsd: 2,
      agentDurationMs: 2_000,
      costSampleCount: 6,
      durationSampleCount: 6,
    });
    expect(
      parseTerminalBenchBudgetManifest(budget, manifest),
    ).toEqual(budget);
  });

  it("rejects fewer than three source jobs", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      jobId: "baseline-1",
      agentName: "pi-baseline",
      omitExtension: true,
    });

    expect(() =>
      calibrateTerminalBenchBudget(manifest, [job, job])
    ).toThrow(/frozen run count/u);
  });

  it("rejects candidate runs as baseline evidence", () => {
    const manifest = createTestManifest();
    const jobs = [1, 2, 3].map((index) =>
      createNormalizedFixtureJob(manifest, {
        jobId: `candidate-${index}`,
      })
    );

    expect(() =>
      calibrateTerminalBenchBudget(manifest, jobs)
    ).toThrow(/frozen agent and model/u);
  });

  it("rejects a budget with fabricated sample coverage", () => {
    const manifest = createTestManifest();
    const jobs = [1, 2, 3].map((index) =>
      createNormalizedFixtureJob(manifest, {
        jobId: `baseline-${index}`,
        agentName: "pi-baseline",
        omitExtension: true,
      })
    );
    const budget = JSON.parse(
      JSON.stringify(
        calibrateTerminalBenchBudget(manifest, jobs),
      ),
    ) as {
      taskBudgets: Array<{ costSampleCount: number }>;
    };
    const first = budget.taskBudgets[0];
    if (first !== undefined) {
      first.costSampleCount = 1;
    }

    expect(() =>
      parseTerminalBenchBudgetManifest(budget, manifest)
    ).toThrow(/enough baseline samples/u);
  });
});
