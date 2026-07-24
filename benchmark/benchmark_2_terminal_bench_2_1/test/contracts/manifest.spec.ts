import { readFile } from "node:fs/promises";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTerminalBenchManifest } from "../../src/index.js";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifestPath = resolve(
  benchmarkRoot,
  "manifests/terminal-bench-2-1-lite-v1.json",
);

describe("Terminal-Bench manifest", () => {
  it("freezes the stratified 10% subset and five-trial contract", async () => {
    const manifest = parseTerminalBenchManifest(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );

    expect(manifest.dataset).toMatchObject({
      id: "terminal-bench/terminal-bench-2-1",
      sourceTaskCount: 89,
      samplingFraction: 0.1,
      selectionMethod: "frozen-stratified-subset",
      expectedTaskCount: 9,
      minimumTrialsPerTask: 5,
      pinning: "resolved-task-checksums",
    });
    expect(
      manifest.dataset.selectedTasks.map((task) => task.id),
    ).toEqual([
      "terminal-bench/fix-git",
      "terminal-bench/build-cython-ext",
      "terminal-bench/cancel-async-tasks",
      "terminal-bench/fix-code-vulnerability",
      "terminal-bench/nginx-request-logging",
      "terminal-bench/db-wal-recovery",
      "terminal-bench/multi-source-data-merger",
      "terminal-bench/large-scale-text-editing",
      "terminal-bench/kv-store-grpc",
    ]);
    expect(manifest.baseline.requiredRuns).toBe(3);
    expect(manifest.scoreSpec.components).toEqual([
      { id: "OfficialReward", weight: 0.8 },
      { id: "CostEfficiency", weight: 0.1 },
      { id: "LatencyEfficiency", weight: 0.05 },
      { id: "Stability", weight: 0.05 },
    ]);
  });

  it("rejects a duplicate task in the frozen subset", async () => {
    const source = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      dataset: {
        selectedTasks: Array<{ id: string }>;
      };
    };
    const firstTaskId = source.dataset.selectedTasks[0]?.id;
    if (
      firstTaskId === undefined ||
      source.dataset.selectedTasks[1] === undefined
    ) {
      throw new Error("Fixture manifest has too few tasks");
    }
    source.dataset.selectedTasks[1].id = firstTaskId;

    expect(() => parseTerminalBenchManifest(source)).toThrow(
      /must be unique/u,
    );
  });

  it("rejects a changed frozen score weight", async () => {
    const source = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      scoreSpec: {
        components: Array<{ id: string; weight: number }>;
      };
    };
    const reward = source.scoreSpec.components.find(
      (component) => component.id === "OfficialReward",
    );
    const cost = source.scoreSpec.components.find(
      (component) => component.id === "CostEfficiency",
    );
    if (reward !== undefined) {
      reward.weight = 0.79;
    }
    if (cost !== undefined) {
      cost.weight = 0.11;
    }

    expect(() => parseTerminalBenchManifest(source)).toThrow(
      /not frozen/u,
    );
  });
});
