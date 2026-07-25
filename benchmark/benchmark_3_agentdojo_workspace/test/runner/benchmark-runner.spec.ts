import {
  mkdtemp,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAgentDojoImport } from "../../src/index.js";
import {
  createNormalizedResult,
  createTestManifest,
} from "../fixtures.js";

const clock = () => new Date("2026-07-23T12:00:00.000Z");

describe("AgentDojo import runner", () => {
  it("records every verifier case and raw pi trace evidence", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-agentdojo-"),
    );
    const manifest = createTestManifest();
    const report = await runAgentDojoImport({
      manifest,
      result: createNormalizedResult(manifest),
      outputDirectory,
      hardwareProfile: "fixture-hardware",
      clock,
    });

    expect(report.gateEvaluation.status).toBe("qualified");
    const artifactRoot = join(
      outputDirectory,
      "artifacts",
      report.runId,
    );
    const summary = JSON.parse(
      await readFile(join(artifactRoot, "summary.json"), "utf8"),
    ) as {
      taskCounts: {
        passed: number;
        failed: number;
        total: number;
      };
      taskResultArtifacts: unknown[];
    };
    expect(summary.taskCounts).toMatchObject({
      passed: 5,
      failed: 3,
      total: 8,
    });
    expect(summary.taskResultArtifacts).toHaveLength(8);
    const successfulAttack = JSON.parse(
      await readFile(
        join(
          artifactRoot,
          "task-results",
          "attack.user_task_0.injection_task_0",
          "trial-1.json",
        ),
        "utf8",
      ),
    ) as {
      status: string;
      metrics: Record<string, number>;
    };
    expect(successfulAttack).toMatchObject({
      status: "failed",
      metrics: {
        utility: 1,
        security: 0,
        targeted_attack_success: 1,
      },
    });
    await expect(
      readFile(
        join(
          artifactRoot,
          "evidence",
          "agentdojo",
          "pi-traces.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("invocation-0");
  });

  it("records a failed adapter run as an invalid task", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "bumblebee-agentdojo-failed-"),
    );
    const manifest = createTestManifest();
    const report = await runAgentDojoImport({
      manifest,
      result: createNormalizedResult(manifest, {
        status: "failed",
      }),
      outputDirectory,
      hardwareProfile: "fixture-hardware",
      clock,
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
      status: string;
      taskCounts: { invalid: number; total: number };
    };
    expect(summary.status).toBe("invalid");
    expect(summary.taskCounts).toMatchObject({
      invalid: 1,
      total: 1,
    });
  });
});
