import { describe, expect, it } from "vitest";

import {
  LONGMEMEVAL_CAPABILITIES,
  parseLongMemEvalDataset,
  parseLongMemEvalManifest,
} from "../../src/index.js";
import {
  loadRawDataset,
  loadRawManifest,
} from "../fixtures.js";

describe("LongMemEval-Bumblebee contracts", () => {
  it("loads 12 cases with complete capability coverage", () => {
    const dataset = parseLongMemEvalDataset(loadRawDataset());

    expect(dataset.cases).toHaveLength(12);
    expect(new Set(dataset.cases.map((item) => item.capability))).toEqual(
      new Set(LONGMEMEVAL_CAPABILITIES),
    );
    expect(dataset.origin).toMatchObject({
      relationship: "capability-inspired-project-authored",
      officialLeaderboardCompatible: false,
    });
  });

  it("freezes profiles, weights, and formal-run boundaries", () => {
    const manifest = parseLongMemEvalManifest(loadRawManifest());

    expect(manifest.profiles).toEqual({
      "memory-core": {
        reader: "none",
        repetitions: 1,
        formal: false,
      },
      "bumblebee-full": {
        reader: "pi",
        repetitions: 3,
        formal: true,
      },
    });
    expect(manifest.reader.taskTimeoutMs).toBe(300_000);
    expect(manifest.aggregation).toMatchObject({
      qaAccuracy: "capability-macro",
      abstentionF1: "global-binary-f1",
    });
    expect(manifest.scoreSpec.components).toHaveLength(6);
  });

  it("rejects score-weight drift", () => {
    const raw = loadRawManifest();
    const scoreSpec = raw.scoreSpec as {
      components: Array<{ id: string; weight: number }>;
    };
    scoreSpec.components[0] = {
      id: "QAAccuracy",
      weight: 0.34,
    };
    scoreSpec.components[1] = {
      id: "RecallAt5",
      weight: 0.21,
    };

    expect(() => parseLongMemEvalManifest(raw)).toThrow(
      /component is not frozen/u,
    );
  });

  it("rejects claims of official leaderboard compatibility", () => {
    const raw = loadRawDataset();
    (raw.origin as Record<string, unknown>)
      .officialLeaderboardCompatible = true;

    expect(() => parseLongMemEvalDataset(raw)).toThrow(
      /adapted-score boundary/u,
    );
  });

  it("rejects overlapping relevant and forbidden memory keys", () => {
    const raw = loadRawDataset();
    const first = (raw.cases as Array<Record<string, unknown>>)[0];
    const query = first?.query as Record<string, unknown>;
    query.forbiddenKeys = ["global:preferred-output-language"];

    expect(() => parseLongMemEvalDataset(raw)).toThrow(
      /overlap/u,
    );
  });

  it("rejects non-chronological event histories", () => {
    const raw = loadRawDataset();
    const first = (raw.cases as Array<Record<string, unknown>>)[0];
    const events = first?.events as Array<Record<string, unknown>>;
    if (events[1] !== undefined) {
      events[1].at = "2026-07-01T00:00:00.000Z";
    }

    expect(() => parseLongMemEvalDataset(raw)).toThrow(
      /chronological/u,
    );
  });

  it("rejects workspace names that can escape the fixture root", () => {
    const raw = loadRawDataset();
    const first = (raw.cases as Array<Record<string, unknown>>)[0];
    first!.workspaces = [".."];

    expect(() => parseLongMemEvalDataset(raw)).toThrow(
      /portable identifier/u,
    );
  });
});
