import {
  mkdtemp,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runTerminalBenchImport } from "../../src/index.js";
import {
  createCalibratedBudget,
  createNormalizedFixtureJob,
  createTestManifest,
} from "../fixtures.js";

describe("Terminal-Bench import runner", () => {
  it("records every normalized trial and the Harbor provenance", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-tb21-"),
    );
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest);
    const report = await runTerminalBenchImport({
      manifest,
      job,
      budget: createCalibratedBudget(manifest),
      outputDirectory,
      clock: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    expect(report.gateEvaluation.status).toBe("qualified");
    expect(report.trialCount).toBe(4);
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
    ) as {
      taskCounts: { total: number };
      taskResultArtifacts: unknown[];
    };
    expect(summary.taskCounts.total).toBe(4);
    expect(summary.taskResultArtifacts).toHaveLength(4);
  });

  it("records namespaced Harbor task IDs with portable paths", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-tb21-namespaced-"),
    );
    const taskIds = [
      "terminal-bench/task-alpha",
      "terminal-bench/task-beta",
    ] as const;
    const manifest = createTestManifest(taskIds);
    const job = createNormalizedFixtureJob(manifest, { taskIds });
    const report = await runTerminalBenchImport({
      manifest,
      job,
      outputDirectory,
      clock: () => new Date("2026-07-23T12:00:00.000Z"),
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
    ) as {
      taskResultArtifacts: Array<{ relativePath: string }>;
    };

    expect(summary.taskResultArtifacts).toHaveLength(4);
    for (const artifact of summary.taskResultArtifacts) {
      const taskResult = JSON.parse(
        await readFile(
          join(
            outputDirectory,
            "artifacts",
            artifact.relativePath,
          ),
          "utf8",
        ),
      ) as {
        taskId: string;
        metadata: { sourceTaskId: string };
      };
      expect(taskResult.taskId).toMatch(/^external-[a-f0-9]{20}$/);
      expect(taskResult.metadata.sourceTaskId).toMatch(
        /^terminal-bench\//,
      );
    }
  });
});
