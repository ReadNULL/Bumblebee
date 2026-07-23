import { describe, expect, it } from "vitest";

import {
  BCS_SCORECARD_CONTRACT_VERSION,
  renderBcsScorecardMarkdown,
  type BcsScorecardReport,
} from "../../src/index.js";

describe("BCS scorecard Markdown", () => {
  it("shows unpublished scores and qualification reasons explicitly", () => {
    const report = {
      contractVersion: BCS_SCORECARD_CONTRACT_VERSION,
      scorecardId: "scorecard_test",
      manifestId: "bcs-v1-scorecard",
      manifestVersion: "1.0.0",
      scoreSpec: "bcs-v1",
      generatedAt: "2026-07-23T10:00:00.000Z",
      qualification: "not-qualified",
      reasons: ["source.TB.qualification:not-qualified"],
      metrics: {},
      gateEvaluation: {
        contractVersion: 1,
        scoreSpec: "bcs-v1",
        status: "qualified",
        decisions: [],
      },
      score: {
        contractVersion: 1,
        scoreSpec: "bcs-v1",
        qualification: "not-qualified",
        score: null,
        components: [],
      },
      sources: [],
    } satisfies BcsScorecardReport;

    const markdown = renderBcsScorecardMarkdown(report);

    expect(markdown).toContain("BCS-v1: **N/A**");
    expect(markdown).toContain(
      "`source.TB.qualification:not-qualified`",
    );
    expect(markdown).toContain("Not published");
  });
});
