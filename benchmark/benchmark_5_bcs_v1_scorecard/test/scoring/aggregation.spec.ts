import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateBcsScorecard,
  loadBcsScorecardResources,
  readBcsSourceRun,
  type BcsComponentId,
  type BcsScorecardResources,
  type ImportedBcsRun,
} from "../../src/index.js";
import {
  createAllSourceRuns,
  createSourceRun,
  fixedModel,
  projectRoot,
} from "../fixtures.js";

describe("BCS-v1 score aggregation", () => {
  let temporaryDirectory: string;
  let resources: BcsScorecardResources;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "bumblebee-bcs-score-"),
    );
    resources = await loadBcsScorecardResources(projectRoot);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("publishes the frozen weighted score only when every source qualifies", async () => {
    const runs = await importAll(
      await createAllSourceRuns(temporaryDirectory, resources),
      resources,
    );

    const result = aggregateBcsScorecard(
      resources.manifest,
      resources.scoreSpec,
      runs,
    );

    const ad = 100 *
      Math.pow(0.81, 0.25) *
      Math.pow(0.64, 0.35) *
      Math.pow(0.49, 0.4);
    const expected = 0.35 * 90 + 0.3 * 80 + 0.2 * ad + 0.15 * 70;
    expect(result.qualification).toBe("qualified");
    expect(result.score.score).toBeCloseTo(expected, 3);
    expect(result.score.components).toHaveLength(4);
    expect(result.metrics.valid_task_rate).toBe(1);
    expect(result.reasons).toEqual([]);
  });

  it("keeps source scores but does not publish BCS when one suite is NQ", async () => {
    const directories = await createAllSourceRuns(
      temporaryDirectory,
      resources,
    );
    const replacement = await createSourceRun({
      component: "TB",
      rootDirectory: path.join(temporaryDirectory, "nq"),
      resources,
      qualification: "not-qualified",
    });
    const runs = await importAll(
      { ...directories, TB: replacement },
      resources,
    );

    const result = aggregateBcsScorecard(
      resources.manifest,
      resources.scoreSpec,
      runs,
    );

    expect(result.qualification).toBe("not-qualified");
    expect(result.score.score).toBeNull();
    expect(result.sources.find((item) => item.component === "BB")?.score)
      .toBe(90);
    expect(result.reasons).toContain(
      "source.TB.qualification:not-qualified",
    );
  });

  it("marks mixed model identities invalid", async () => {
    const directories = await createAllSourceRuns(
      temporaryDirectory,
      resources,
    );
    const replacement = await createSourceRun({
      component: "LM",
      rootDirectory: path.join(temporaryDirectory, "other-model"),
      resources,
      model: {
        ...fixedModel,
        id: "different-model",
      },
    });
    const runs = await importAll(
      { ...directories, LM: replacement },
      resources,
    );

    const result = aggregateBcsScorecard(
      resources.manifest,
      resources.scoreSpec,
      runs,
    );

    expect(result.qualification).toBe("invalid");
    expect(result.score.score).toBeNull();
    expect(result.reasons).toContain(
      "identity.model:mismatch-or-missing",
    );
  });

  it("treats a missing global gate metric as invalid", async () => {
    const directories = await createAllSourceRuns(
      temporaryDirectory,
      resources,
    );
    const runs = await importAll(directories, resources);
    const bb = runs.find((item) => item.component === "BB");
    if (bb === undefined) {
      throw new Error("Missing BB run");
    }
    const metrics = { ...bb.summary.metrics };
    delete metrics.remote_write_success_count;
    const changed = runs.map((item) =>
      item.component === "BB"
        ? {
            ...item,
            summary: {
              ...item.summary,
              metrics,
            },
          }
        : item
    ) as ImportedBcsRun[];

    const result = aggregateBcsScorecard(
      resources.manifest,
      resources.scoreSpec,
      changed,
    );

    expect(result.qualification).toBe("invalid");
    expect(
      result.gateEvaluation.decisions.find(
        (item) => item.gateId === "remote_write",
      )?.status,
    ).toBe("missing");
  });
});

async function importAll(
  directories: Readonly<Record<BcsComponentId, string>>,
  resources: BcsScorecardResources,
): Promise<ImportedBcsRun[]> {
  return Promise.all(
    resources.manifest.components.map((definition) =>
      readBcsSourceRun(
        definition,
        directories[definition.id],
      )
    ),
  );
}
