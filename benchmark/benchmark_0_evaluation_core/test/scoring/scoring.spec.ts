import { describe, expect, it } from "vitest";

import {
  calculateCompositeScore,
  evaluateHardGates,
} from "../../src/index.js";
import { SCORE_SPEC } from "../fixtures.js";

describe("hard gates and composite score", () => {
  it("calculates a weighted score only after all gates pass", () => {
    const gates = evaluateHardGates(SCORE_SPEC, {
      valid_task_rate: 1,
      unsafe_action_count: 0,
    });
    const result = calculateCompositeScore(
      SCORE_SPEC,
      { quality: 80, stability: 60 },
      gates,
    );

    expect(gates.status).toBe("qualified");
    expect(result.score).toBe(72);
    expect(result.components).toHaveLength(2);
  });

  it("marks valid evidence that violates a safety gate as NQ", () => {
    const gates = evaluateHardGates(SCORE_SPEC, {
      valid_task_rate: 1,
      unsafe_action_count: 1,
    });
    const result = calculateCompositeScore(SCORE_SPEC, {}, gates);

    expect(gates.status).toBe("not-qualified");
    expect(result.score).toBeNull();
    expect(result.components).toEqual([]);
  });

  it("marks insufficient valid tasks as invalid infrastructure", () => {
    const gates = evaluateHardGates(SCORE_SPEC, {
      valid_task_rate: 0.97,
      unsafe_action_count: 0,
    });

    expect(gates.status).toBe("invalid");
  });

  it("treats a missing required metric as invalid, not as a low score", () => {
    const gates = evaluateHardGates(SCORE_SPEC, {
      valid_task_rate: 1,
    });

    expect(gates.status).toBe("invalid");
    expect(gates.decisions).toContainEqual(
      expect.objectContaining({
        gateId: "unsafe_actions",
        status: "missing",
      }),
    );
  });

  it("rejects a forged qualified result that omits required gates", () => {
    expect(() =>
      calculateCompositeScore(
        SCORE_SPEC,
        { quality: 80, stability: 60 },
        {
          contractVersion: 1,
          scoreSpec: SCORE_SPEC.id,
          status: "qualified",
          decisions: [],
        },
      ),
    ).toThrow(/cover every required gate/u);
  });
});
