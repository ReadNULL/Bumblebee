import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvaluationRunStore,
  calculateCompositeScore,
  evaluateHardGates,
} from "../../src/index.js";
import {
  FIXED_TIME,
  SCORE_SPEC,
  createRunInput,
} from "../fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("EvaluationRunStore", () => {
  it("records start, task evidence, sanitized failures and final summary", async () => {
    const outputDirectory = await createTemporaryDirectory();
    const store = new EvaluationRunStore({
      outputDirectory,
      clock: () => new Date(FIXED_TIME),
      runIdFactory: () => "run-fixture",
    });
    const run = await store.startRun(createRunInput());
    const evidence = await run.recordJsonArtifact({
      relativePath: "verifier.json",
      kind: "verifier",
      mediaType: "application/json",
      value: { authorization: "Bearer secret-value", passed: false },
    });

    await Promise.all([
      run.recordTask({
        taskId: "task-a",
        trial: 1,
        status: "passed",
        startedAt: FIXED_TIME,
        finishedAt: FIXED_TIME,
        durationMs: 0,
        reward: 1,
      }),
      run.recordTask({
        taskId: "task-b",
        trial: 1,
        status: "failed",
        startedAt: FIXED_TIME,
        finishedAt: FIXED_TIME,
        durationMs: 0,
        reward: 0,
        failure: {
          category: "bumblebee",
          code: "ASSERTION_FAILED",
          message: "token=must-not-be-persisted",
        },
        artifacts: [evidence],
      }),
    ]);

    const metrics = {
      valid_task_rate: 1,
      unsafe_action_count: 0,
    };
    const gates = evaluateHardGates(SCORE_SPEC, metrics);
    const score = calculateCompositeScore(
      SCORE_SPEC,
      { quality: 50, stability: 100 },
      gates,
    );
    const finalized = await run.finalize({
      status: "completed",
      metrics,
      gateEvaluation: gates,
      compositeScore: score,
      lessonIds: ["lesson-fixture"],
      finishedAt: FIXED_TIME,
    });

    expect(finalized.summary.taskCounts).toEqual({
      passed: 1,
      failed: 1,
      cancelled: 0,
      invalid: 0,
      total: 2,
    });
    expect(finalized.summary.compositeScore?.score).toBe(70);

    const ledger = await readFile(
      join(outputDirectory, "history", "runs.jsonl"),
      "utf8",
    );
    const ledgerEntries = ledger.trim().split(/\r?\n/u).map(
      (line) => JSON.parse(line) as { event: string },
    );
    expect(ledgerEntries.map((entry) => entry.event)).toEqual([
      "run_started",
      "run_finished",
    ]);

    const failedResult = await readFile(
      join(
        outputDirectory,
        "artifacts",
        "run-fixture",
        "task-results",
        "task-b",
        "trial-1.json",
      ),
      "utf8",
    );
    expect(failedResult).not.toContain("must-not-be-persisted");
    expect(failedResult).toContain("[REDACTED]");

    await expect(
      run.recordRawArtifact({
        relativePath: "late.txt",
        kind: "other",
        mediaType: "text/plain",
        content: "too late",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects duplicate task trials before they can alter counts", async () => {
    const store = new EvaluationRunStore({
      outputDirectory: await createTemporaryDirectory(),
      runIdFactory: () => "run-duplicate",
    });
    const run = await store.startRun(createRunInput());
    const task = {
      taskId: "same-task",
      trial: 1,
      status: "passed" as const,
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      durationMs: 0,
    };

    await run.recordTask(task);
    await expect(run.recordTask(task)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "bumblebee-benchmark-runs-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}
