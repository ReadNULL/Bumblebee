import { describe, expect, it } from "vitest";

import { aggregateLongMemEval } from "../../src/index.js";
import {
  createPerfectResults,
  createTestDataset,
  createTestManifest,
} from "../fixtures.js";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("LongMemEval aggregation", () => {
  it("qualifies a complete formal result and computes all components", () => {
    const manifest = createTestManifest();
    const dataset = createTestDataset();
    const aggregation = aggregateLongMemEval({
      manifest,
      dataset,
      datasetSha256: manifest.dataset.sha256,
      profile: "bumblebee-full",
      results: createPerfectResults(dataset, "bumblebee-full", 3),
      observedPiVersion: manifest.reader.piVersion,
      bumblebeeCommit: commit,
      workspaceClean: true,
    });

    expect(aggregation.gateEvaluation.status).toBe("qualified");
    expect(aggregation.componentScores).toEqual({
      QAAccuracy: 100,
      RecallAt5: 100,
      PrecisionAt5: 100,
      UpdateAccuracy: 100,
      AbstentionF1: 100,
      IsolationAccuracy: 100,
    });
    expect(aggregation.score.score).toBe(100);
    expect(aggregation.metrics.critical_unsafe_action_count).toBe(0);
  });

  it("keeps memory-core diagnostic runs unqualified", () => {
    const manifest = createTestManifest();
    const dataset = createTestDataset();
    const results = createPerfectResults(
      dataset,
      "memory-core",
      1,
    ).map((result) => {
      const {
        qaAccuracy: _qaAccuracy,
        predictedAbstention: _predictedAbstention,
        ...metrics
      } = result.metrics;
      const { reader: _reader, ...withoutReader } = result;
      return {
        ...withoutReader,
        metrics,
      };
    });
    const aggregation = aggregateLongMemEval({
      manifest,
      dataset,
      datasetSha256: manifest.dataset.sha256,
      profile: "memory-core",
      results,
      observedPiVersion: manifest.reader.piVersion,
      bumblebeeCommit: commit,
      workspaceClean: true,
    });

    expect(aggregation.gateEvaluation.status).toBe("not-qualified");
    expect(aggregation.metrics.answer_coverage_rate).toBe(0);
    expect(aggregation.score.score).toBeNull();
  });

  it("marks an incomplete trial matrix invalid", () => {
    const manifest = createTestManifest();
    const dataset = createTestDataset();
    const results = createPerfectResults(
      dataset,
      "bumblebee-full",
      3,
    ).slice(1);
    const aggregation = aggregateLongMemEval({
      manifest,
      dataset,
      datasetSha256: manifest.dataset.sha256,
      profile: "bumblebee-full",
      results,
      observedPiVersion: manifest.reader.piVersion,
      bumblebeeCommit: commit,
      workspaceClean: true,
    });

    expect(aggregation.gateEvaluation.status).toBe("invalid");
    expect(aggregation.metrics.adapter_error_count).toBe(1);
    expect(aggregation.score.score).toBeNull();
  });
});
