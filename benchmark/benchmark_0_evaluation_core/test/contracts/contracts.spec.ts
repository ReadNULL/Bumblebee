import { describe, expect, it } from "vitest";

import {
  assertEvaluationTaskResultInput,
  assertScoreSpec,
  assertStartEvaluationRunInput,
  type EvaluationTaskResultInput,
} from "../../src/index.js";
import {
  FIXED_TIME,
  SCORE_SPEC,
  createRunInput,
} from "../fixtures.js";

describe("evaluation contracts", () => {
  it("accepts a complete versioned run manifest input", () => {
    expect(() =>
      assertStartEvaluationRunInput(createRunInput()),
    ).not.toThrow();
  });

  it("rejects a dataset identity without a SHA-256 digest", () => {
    const input = createRunInput({
      suite: {
        ...createRunInput().suite,
        datasetHash: "mutable-latest",
      },
    });

    expect(() => assertStartEvaluationRunInput(input)).toThrow(
      /SHA-256/u,
    );
  });

  it("requires failed and invalid tasks to explain their failure", () => {
    const result = {
      taskId: "task-1",
      trial: 1,
      status: "failed",
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      durationMs: 0,
    } as EvaluationTaskResultInput;

    expect(() => assertEvaluationTaskResultInput(result)).toThrow(
      /failure details/u,
    );
  });

  it("rejects score specs whose frozen weights do not sum to one", () => {
    expect(() =>
      assertScoreSpec({
        ...SCORE_SPEC,
        components: [
          { id: "quality", weight: 0.6 },
          { id: "stability", weight: 0.3 },
        ],
      }),
    ).toThrow(/sum to 1/u);
  });
});
