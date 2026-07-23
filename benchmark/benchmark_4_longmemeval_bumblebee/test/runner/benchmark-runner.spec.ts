import {
  mkdtemp,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runLongMemEvalBenchmark,
} from "../../src/index.js";
import {
  CorrectMemoryReader,
  createTestDataset,
  createTestManifest,
} from "../fixtures.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("LongMemEval benchmark runner", () => {
  it("records all 12 memory-core cases and returns NQ", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-lm-core-"),
    );
    const manifest = createTestManifest();
    const dataset = createTestDataset();
    const report = await runLongMemEvalBenchmark({
      manifest,
      dataset,
      datasetSha256: manifest.dataset.sha256,
      profile: "memory-core",
      outputDirectory,
      hardwareProfile: "fixture-hardware",
      observedPiVersion: manifest.reader.piVersion,
      bumblebeeCommit: commit,
      workspaceClean: true,
    });

    expect(report.gateEvaluation.status).toBe("not-qualified");
    expect(report.score.score).toBeNull();
    expect(report.metrics).toMatchObject({
      adapter_error_count: 0,
      valid_task_rate: 1,
      memory_scope_leak_count: 0,
      secret_persisted_count: 0,
    });
    const summary = JSON.parse(
      await readFile(
        join(
          outputDirectory,
          "artifacts",
          report.runId,
          "summary.json",
        ),
        "utf8",
      ),
    ) as { taskCounts: { total: number; passed: number } };
    expect(summary.taskCounts).toMatchObject({
      total: 12,
      passed: 12,
    });
  });

  it("runs the complete 36-answer formal matrix with an injected reader", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-lm-full-"),
    );
    const manifest = createTestManifest();
    const dataset = createTestDataset();
    const report = await runLongMemEvalBenchmark({
      manifest,
      dataset,
      datasetSha256: manifest.dataset.sha256,
      profile: "bumblebee-full",
      reader: new CorrectMemoryReader(),
      outputDirectory,
      hardwareProfile: "fixture-hardware",
      observedPiVersion: manifest.reader.piVersion,
      bumblebeeCommit: commit,
      workspaceClean: true,
      model: {
        provider: "fixture",
        id: "fixture-reader",
      },
    });

    expect(report.gateEvaluation.status).toBe("qualified");
    expect(report.score.score).toBe(98.5);
    expect(report.componentScores).toMatchObject({
      QAAccuracy: 100,
      RecallAt5: 100,
      PrecisionAt5: 85,
      UpdateAccuracy: 100,
      AbstentionF1: 100,
      IsolationAccuracy: 100,
    });
    const summary = JSON.parse(
      await readFile(
        join(
          outputDirectory,
          "artifacts",
          report.runId,
          "summary.json",
        ),
        "utf8",
      ),
    ) as { taskCounts: { total: number; passed: number } };
    expect(summary.taskCounts).toMatchObject({
      total: 36,
      passed: 36,
    });
  });
});
