import type {
  BcsScorecardReport,
} from "../contracts/index.js";

export function renderBcsScorecardMarkdown(
  report: BcsScorecardReport,
): string {
  const total = report.score.score === null
    ? "N/A"
    : report.score.score.toFixed(2);
  const lines = [
    "# BCS-v1 Scorecard",
    "",
    `- Scorecard: \`${report.scorecardId}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Qualification: **${report.qualification}**`,
    `- BCS-v1: **${total}**`,
    "",
    "## Source Suites",
    "",
    "| Component | Run | Suite | Qualification | Score | Tasks | Commit | Pi | Model |",
    "| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |",
    ...report.sources.map((source) =>
      `| ${[
        source.component,
        code(source.runId),
        code(`${source.suiteId}@${source.suiteVersion}`),
        source.qualification,
        source.score === null ? "N/A" : source.score.toFixed(2),
        `${source.taskCounts.passed + source.taskCounts.failed}/${source.taskCounts.total}`,
        code(shortCommit(source.subject.bumblebeeCommit)),
        code(source.subject.piVersion),
        source.model === undefined
          ? "N/A"
          : code(
              `${source.model.provider}/${source.model.id}` +
                (
                  source.model.thinkingLevel === undefined
                    ? ""
                    : ` (${source.model.thinkingLevel})`
                ),
            ),
      ].join(" | ")} |`
    ),
    "",
    "## Weighted Score",
    "",
    "| Component | Score | Weight | Contribution |",
    "| --- | ---: | ---: | ---: |",
    ...(report.score.components.length === 0
      ? ["| N/A | N/A | N/A | Not published |"]
      : report.score.components.map((component) =>
          `| ${component.id} | ${component.score.toFixed(2)} | ` +
          `${(component.weight * 100).toFixed(0)}% | ` +
          `${component.contribution.toFixed(2)} |`
        )),
    "",
    "## Hard Gates",
    "",
    "| Gate | Metric | Rule | Actual | Status |",
    "| --- | --- | --- | ---: | --- |",
    ...report.gateEvaluation.decisions.map((decision) =>
      `| ${escapeCell(decision.gateId)} | ` +
      `${escapeCell(decision.metric)} | ` +
      `${decision.operator} ${decision.threshold} | ` +
      `${decision.actual ?? "missing"} | ${decision.status} |`
    ),
    "",
    "## Qualification Reasons",
    "",
    ...(report.reasons.length === 0
      ? ["- None"]
      : report.reasons.map((reason) => `- \`${reason}\``)),
    "",
    "## Evidence",
    "",
    "| Component | Manifest SHA-256 | Summary SHA-256 |",
    "| --- | --- | --- |",
    ...report.sources.map((source) =>
      `| ${source.component} | \`${source.manifestSha256}\` | ` +
      `\`${source.summarySha256}\` |`
    ),
    "",
  ];
  return lines.join("\n");
}

function code(value: string): string {
  return `\`${escapeCell(value)}\``;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function shortCommit(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
