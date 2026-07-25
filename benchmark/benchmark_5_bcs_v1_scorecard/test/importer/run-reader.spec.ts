import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadBcsScorecardResources,
  readBcsSourceRun,
  type BcsScorecardResources,
} from "../../src/index.js";
import {
  createSourceRun,
  projectRoot,
} from "../fixtures.js";

describe("BCS source run reader", () => {
  let temporaryDirectory: string;
  let resources: BcsScorecardResources;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "bumblebee-bcs-import-"),
    );
    resources = await loadBcsScorecardResources(projectRoot);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("verifies ledger hashes and derives AgentDojo score from summary metrics", async () => {
    const runDirectory = await createSourceRun({
      component: "AD",
      rootDirectory: temporaryDirectory,
      resources,
    });
    const definition = resources.manifest.components.find(
      (item) => item.id === "AD",
    );
    if (definition === undefined) {
      throw new Error("Missing AD definition");
    }

    const imported = await readBcsSourceRun(
      definition,
      runDirectory,
    );

    const expected = 100 *
      Math.pow(0.81, 0.25) *
      Math.pow(0.64, 0.35) *
      Math.pow(0.49, 0.4);
    expect(imported.score).toBeCloseTo(expected, 4);
    expect(imported.qualification).toBe("qualified");
    expect(imported.summary.taskResultArtifacts).toHaveLength(1);
  });

  it("rejects a summary changed after the run was finalized", async () => {
    const runDirectory = await createSourceRun({
      component: "BB",
      rootDirectory: temporaryDirectory,
      resources,
    });
    const summaryPath = path.join(runDirectory, "summary.json");
    const summary = JSON.parse(
      await readFile(summaryPath, "utf8"),
    ) as { metrics: Record<string, number> };
    summary.metrics.typecheck_pass_rate = 0;
    await writeFile(
      summaryPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    const definition = resources.manifest.components.find(
      (item) => item.id === "BB",
    );
    if (definition === undefined) {
      throw new Error("Missing BB definition");
    }

    await expect(
      readBcsSourceRun(definition, runDirectory),
    ).rejects.toThrow(/integrity verification/u);
  });

  it("rejects a smoke run at the formal score boundary", async () => {
    const runDirectory = await createSourceRun({
      component: "BB",
      rootDirectory: temporaryDirectory,
      resources,
      metadata: { profile: "smoke" },
    });
    const definition = resources.manifest.components.find(
      (item) => item.id === "BB",
    );
    if (definition === undefined) {
      throw new Error("Missing BB definition");
    }

    await expect(
      readBcsSourceRun(definition, runDirectory),
    ).rejects.toThrow(/formal benchmark profile/u);
  });
});
