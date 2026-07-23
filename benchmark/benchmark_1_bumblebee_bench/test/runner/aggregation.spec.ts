import { describe, expect, it } from "vitest";

import {
  aggregateBumblebeeBench,
} from "../../src/index.js";
import {
  createPassingResults,
  loadFixtureManifest,
} from "../fixtures.js";

describe("BumblebeeBench aggregation", () => {
  it("publishes a weighted score only when every scenario and gate passes", async () => {
    const manifest = await loadFixtureManifest();
    const result = aggregateBumblebeeBench(
      manifest,
      createPassingResults(manifest),
      1,
      { typecheckPassRate: 1 },
    );

    expect(result.domains).toHaveLength(6);
    expect(result.gateEvaluation.status).toBe("qualified");
    expect(result.score.score).toBe(100);
    expect(result.metrics.valid_task_rate).toBe(1);
  });

  it("marks a deterministic or safety regression as not-qualified", async () => {
    const manifest = await loadFixtureManifest();
    const results = createPassingResults(manifest);
    results[0] = {
      ...results[0]!,
      status: "failed",
      correctness: 0,
      reward: 0.2,
      assertions: [{ id: "fixture-passed", passed: false }],
      metrics: { session_order_violation_count: 1 },
      failure: {
        category: "bumblebee",
        code: "ASSERTION_FAILED",
        message: "fixture failure",
      },
    };

    const result = aggregateBumblebeeBench(
      manifest,
      results,
      1,
      { typecheckPassRate: 1 },
    );

    expect(result.gateEvaluation.status).toBe("not-qualified");
    expect(result.score.score).toBeNull();
    expect(result.metrics.session_order_violation_count).toBe(1);
  });

  it("marks insufficient valid task evidence as invalid", async () => {
    const manifest = await loadFixtureManifest();
    const results = createPassingResults(manifest);
    results[0] = {
      ...results[0]!,
      status: "invalid",
      correctness: 0,
      reward: 0,
      assertions: [],
      failure: {
        category: "infrastructure",
        code: "FIXTURE_SETUP_FAILED",
        message: "fixture failed",
      },
    };

    const result = aggregateBumblebeeBench(
      manifest,
      results,
      1,
      { typecheckPassRate: 1 },
    );

    expect(result.gateEvaluation.status).toBe("invalid");
    expect(result.score.score).toBeNull();
    expect(result.metrics.valid_task_rate).toBeCloseTo(11 / 12);
  });

  it("does not claim qualification when the explicit typecheck preflight failed", async () => {
    const manifest = await loadFixtureManifest();
    const result = aggregateBumblebeeBench(
      manifest,
      createPassingResults(manifest),
      1,
      { typecheckPassRate: 0 },
    );

    expect(result.gateEvaluation.status).toBe("not-qualified");
    expect(result.score.score).toBeNull();
    expect(result.metrics.typecheck_pass_rate).toBe(0);
  });
});
