import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateBcsEnvironmentRecoveryPublication,
  loadBcsEnvironmentRecoveryPublication,
  loadBcsScorecardResources,
  parseBcsEnvironmentRecoveryPublication,
} from "../../src/index.js";
import { benchmarkRoot, projectRoot } from "../fixtures.js";

const publicationPath = path.join(
  benchmarkRoot,
  "manifests",
  "bcs-v1-environment-recovery-2026-07-25.json",
);
const terminalTaskIds = [
  "terminal-bench/fix-git",
  "terminal-bench/build-cython-ext",
  "terminal-bench/cancel-async-tasks",
  "terminal-bench/fix-code-vulnerability",
  "terminal-bench/nginx-request-logging",
  "terminal-bench/db-wal-recovery",
  "terminal-bench/multi-source-data-merger",
  "terminal-bench/large-scale-text-editing",
  "terminal-bench/kv-store-grpc",
] as const;

describe("BCS-v1 environment recovery publication", () => {
  it("publishes the audited aggregate TB score and BCS-v1", async () => {
    const resources = await loadBcsScorecardResources(projectRoot);
    const publication =
      await loadBcsEnvironmentRecoveryPublication(projectRoot);
    const result = calculateBcsEnvironmentRecoveryPublication(
      resources,
      publication,
    );

    expect(result.components).toEqual([
      expect.objectContaining({ id: "BB", score: 100 }),
      expect.objectContaining({
        id: "TB",
        score: 93.3333,
        taskCounts: {
          total: 45,
          passed: 42,
          failed: 1,
          invalid: 2,
          cancelled: 0,
        },
      }),
      expect.objectContaining({ id: "AD", score: 94.3899 }),
      expect.objectContaining({ id: "LM", score: 98.5 }),
    ]);
    expect(result.metrics.valid_task_rate).toBe(0.9981);
    expect(result.score.qualification).toBe("qualified");
    expect(result.score.score).toBe(96.653);
  });

  it("rejects duplicate task selection in the aggregate", async () => {
    const value = await readPublicationFixture();
    const terminal = findComponent(value, "TB");
    const batches = terminal.selectedBatches as Array<{
      taskId: string;
    }>;
    (batches[0] as { taskId: string }).taskId =
      (batches[1] as { taskId: string }).taskId;

    expect(() =>
      parseBcsEnvironmentRecoveryPublication(value, terminalTaskIds)
    ).toThrow(/frozen task set/u);
  });

  it("requires an infrastructure explanation for invalid trials", async () => {
    const value = await readPublicationFixture();
    const terminal = findComponent(value, "TB");
    const batches = terminal.selectedBatches as Array<
      Record<string, unknown>
    >;
    const invalidBatch = batches.find((batch) => batch.invalid === 2);
    if (invalidBatch === undefined) {
      throw new Error("Publication fixture has no invalid TB batch");
    }
    delete invalidBatch.invalidReason;

    expect(() =>
      parseBcsEnvironmentRecoveryPublication(value, terminalTaskIds)
    ).toThrow(/explain infrastructure invalid trials/u);
  });

  it("rejects selected batches that exceed source job totals", async () => {
    const value = await readPublicationFixture();
    const terminal = findComponent(value, "TB");
    const jobs = terminal.sourceJobs as Array<Record<string, unknown>>;
    const fullJob = jobs.find(
      (job) => job.name === "tb21-lite-bumblebee-1-20260724-r1",
    );
    if (fullJob === undefined) {
      throw new Error("Publication fixture has no full TB job");
    }
    fullJob.passed = 22;
    fullJob.failed = 18;

    expect(() =>
      parseBcsEnvironmentRecoveryPublication(value, terminalTaskIds)
    ).toThrow(/contradict source job totals/u);
  });

  it("rejects a standard score that contradicts its metrics", async () => {
    const value = await readPublicationFixture();
    const agentDojo = findComponent(value, "AD");
    agentDojo.score = 99;
    const resources = await loadBcsScorecardResources(projectRoot);
    const publication = parseBcsEnvironmentRecoveryPublication(
      value,
      terminalTaskIds,
    );

    expect(() =>
      calculateBcsEnvironmentRecoveryPublication(resources, publication)
    ).toThrow(/does not match its metrics/u);
  });
});

async function readPublicationFixture(): Promise<{
  components: Array<Record<string, unknown>>;
}> {
  return JSON.parse(
    await readFile(publicationPath, "utf8"),
  ) as {
    components: Array<Record<string, unknown>>;
  };
}

function findComponent(
  value: { components: Array<Record<string, unknown>> },
  id: string,
): Record<string, unknown> {
  const component = value.components.find((item) => item.id === id);
  if (component === undefined) {
    throw new Error(`Publication fixture has no ${id} component`);
  }
  return component;
}
