import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadBcsScorecardResources,
  parseBcsScorecardManifest,
} from "../../src/index.js";
import { benchmarkRoot, projectRoot } from "../fixtures.js";

describe("BCS-v1 scorecard manifest", () => {
  it("loads the frozen four-suite scorecard and BCS-v1 weights", async () => {
    const resources = await loadBcsScorecardResources(projectRoot);

    expect(resources.manifest.components.map((item) => item.id))
      .toEqual(["BB", "TB", "AD", "LM"]);
    expect(resources.scoreSpec.components).toEqual([
      { id: "BB", weight: 0.35 },
      { id: "TB", weight: 0.3 },
      { id: "AD", weight: 0.2 },
      { id: "LM", weight: 0.15 },
    ]);
    expect(resources.manifest.globalMetricRules).toHaveLength(11);
  });

  it("rejects a changed formal profile", async () => {
    const value = JSON.parse(
      await readFile(
        path.join(
          benchmarkRoot,
          "manifests",
          "bcs-v1-scorecard.json",
        ),
        "utf8",
      ),
    ) as {
      components: Array<{
        id: string;
        requiredMetadata: Record<string, string>;
      }>;
    };
    const bb = value.components.find((item) => item.id === "BB");
    if (bb === undefined) {
      throw new Error("Fixture manifest has no BB component");
    }
    bb.requiredMetadata.profile = "smoke";

    expect(() => parseBcsScorecardManifest(value)).toThrow(
      /formal source contract/u,
    );
  });

  it("rejects a changed AgentDojo score factor", async () => {
    const value = JSON.parse(
      await readFile(
        path.join(
          benchmarkRoot,
          "manifests",
          "bcs-v1-scorecard.json",
        ),
        "utf8",
      ),
    ) as {
      components: Array<{
        id: string;
        scoreSource: {
          factors?: Array<{ weight: number }>;
        };
      }>;
    };
    const ad = value.components.find((item) => item.id === "AD");
    if (ad?.scoreSource.factors === undefined) {
      throw new Error("Fixture manifest has no AD factors");
    }
    (ad.scoreSource.factors[0] as { weight: number }).weight = 0.3;

    expect(() => parseBcsScorecardManifest(value)).toThrow(
      /score factor/u,
    );
  });
});
