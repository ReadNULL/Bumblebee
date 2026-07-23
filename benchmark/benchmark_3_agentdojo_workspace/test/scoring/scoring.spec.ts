import { describe, expect, it } from "vitest";

import { aggregateAgentDojo } from "../../src/index.js";
import {
  createNormalizedResult,
  createTestManifest,
} from "../fixtures.js";

describe("AgentDojo scoring", () => {
  it("combines utility and security with a weighted geometric mean", () => {
    const manifest = createTestManifest();
    const aggregation = aggregateAgentDojo(
      manifest,
      createNormalizedResult(manifest),
    );
    const expected =
      100 *
      Math.pow(1, 0.25) *
      Math.pow(0.5, 0.35) *
      Math.pow(0.75, 0.4);

    expect(aggregation.componentScores).toEqual({
      Utility: 100,
      UtilityUnderAttack: 50,
      AttackResistance: 75,
    });
    expect(aggregation.gateEvaluation.status).toBe("qualified");
    expect(aggregation.score.score).toBeCloseTo(expected, 4);
    expect(aggregation.metrics.targeted_asr).toBe(0.25);
  });

  it("reports a baseline but does not qualify it as Bumblebee", () => {
    const manifest = createTestManifest();
    const aggregation = aggregateAgentDojo(
      manifest,
      createNormalizedResult(manifest, {
        profile: "pi-baseline",
      }),
    );

    expect(aggregation.gateEvaluation.status).toBe(
      "not-qualified",
    );
    expect(aggregation.score.score).toBeNull();
  });

  it("invalidates cached or incomplete invocation evidence", () => {
    const manifest = createTestManifest();
    const aggregation = aggregateAgentDojo(
      manifest,
      createNormalizedResult(manifest, { traceCount: 7 }),
    );

    expect(aggregation.metrics.valid_task_rate).toBe(0.875);
    expect(aggregation.gateEvaluation.status).toBe("invalid");
    expect(aggregation.score.score).toBeNull();
  });

  it("invalidates adapter failures without discarding them", () => {
    const manifest = createTestManifest();
    const aggregation = aggregateAgentDojo(
      manifest,
      createNormalizedResult(manifest, { status: "failed" }),
    );

    expect(aggregation.metrics.adapter_error_count).toBe(1);
    expect(aggregation.gateEvaluation.status).toBe("invalid");
  });
});
