import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runLongMemEvalCase } from "../../src/index.js";
import {
  CorrectMemoryReader,
  createTestDataset,
} from "../fixtures.js";

describe("LongMemEval case runner", () => {
  it("updates a stable key and removes the stale value", async () => {
    const dataset = createTestDataset();
    const testCase = dataset.cases.find(
      (item) => item.id === "knowledge-update-test-command",
    );
    expect(testCase).toBeDefined();
    const result = await runLongMemEvalCase({
      case: testCase as NonNullable<typeof testCase>,
      fixtureDirectory: await mkdtemp(
        join(tmpdir(), "bumblebee-lm-update-"),
      ),
      profile: "bumblebee-full",
      trial: 1,
      reader: new CorrectMemoryReader(),
    });

    expect(result.status).toBe("completed");
    expect(result.metrics).toMatchObject({
      qaAccuracy: 1,
      recallAt5: 1,
      updateAccuracy: 1,
    });
    expect(result.evidence.stateChecksPassed).toBe(true);
    expect(result.evidence.memoryContext).not.toContain("vitest run");
  });

  it("keeps moved project memory isolated and abstains", async () => {
    const dataset = createTestDataset();
    const testCase = dataset.cases.find(
      (item) => item.id === "isolation-project-move",
    );
    expect(testCase).toBeDefined();
    const result = await runLongMemEvalCase({
      case: testCase as NonNullable<typeof testCase>,
      fixtureDirectory: await mkdtemp(
        join(tmpdir(), "bumblebee-lm-move-"),
      ),
      profile: "bumblebee-full",
      trial: 1,
      reader: new CorrectMemoryReader(),
    });

    expect(result.evidence.retrievedKeys).toEqual([]);
    expect(result.evidence.memoryScopeLeakCount).toBe(0);
    expect(result.metrics).toMatchObject({
      qaAccuracy: 1,
      predictedAbstention: true,
      isolationAccuracy: 1,
    });
  });

  it("uses project-only read-only context and rejects a secret", async () => {
    const dataset = createTestDataset();
    const testCase = dataset.cases.find(
      (item) =>
        item.id === "isolation-feishu-read-only-and-secret",
    );
    expect(testCase).toBeDefined();
    const reader = new CorrectMemoryReader();
    const result = await runLongMemEvalCase({
      case: testCase as NonNullable<typeof testCase>,
      fixtureDirectory: await mkdtemp(
        join(tmpdir(), "bumblebee-lm-readonly-"),
      ),
      profile: "bumblebee-full",
      trial: 1,
      reader,
    });

    expect(result.evidence.memoryScopeLeakCount).toBe(0);
    expect(result.evidence.secretPersistedCount).toBe(0);
    expect(result.metrics.isolationAccuracy).toBe(1);
    expect(result.evidence.memoryContext).toContain(
      "read-only memory access",
    );
    expect(result.evidence.memoryContext).not.toContain(
      "GLOBAL-LEAK-MARKER",
    );
    expect(result.evidence.memoryContext).toContain("\\u003c");
    expect(
      result.evidence.memoryContext.match(/<memory-context>/gu),
    ).toHaveLength(1);
  });
});
