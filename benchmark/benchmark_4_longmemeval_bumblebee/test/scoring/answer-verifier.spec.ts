import { describe, expect, it } from "vitest";

import { evaluateLongMemEvalAnswer } from "../../src/index.js";

describe("LongMemEval answer verifier", () => {
  it("requires every semantic group while allowing synonyms", () => {
    const result = evaluateLongMemEvalAnswer(
      "安全评审更早，二者相差三天。",
      {
        requiredGroups: [
          ["安全评审"],
          ["3 天", "三天"],
        ],
        forbiddenTerms: [],
        abstain: false,
      },
    );

    expect(result).toMatchObject({
      answered: true,
      abstained: false,
      correct: true,
    });
  });

  it("rejects stale or malicious forbidden content", () => {
    const result = evaluateLongMemEvalAnswer(
      "新命令是 npm run test:ci，但也可使用 vitest run。",
      {
        requiredGroups: [["npm run test:ci"]],
        forbiddenTerms: ["vitest run"],
        abstain: false,
      },
    );

    expect(result.correct).toBe(false);
    expect(result.matchedForbiddenTerms).toEqual(["vitest run"]);
  });

  it("recognizes explicit abstention without accepting an empty answer", () => {
    const rubric = {
      requiredGroups: [],
      forbiddenTerms: ["5432"],
      abstain: true,
    } as const;

    expect(
      evaluateLongMemEvalAnswer(
        "没有相关记忆，无法确定。",
        rubric,
      ).correct,
    ).toBe(true);
    expect(evaluateLongMemEvalAnswer("", rubric).correct).toBe(false);
    expect(
      evaluateLongMemEvalAnswer(
        "没有相关记忆，猜测是 5432。",
        rubric,
      ).correct,
    ).toBe(false);
  });
});
