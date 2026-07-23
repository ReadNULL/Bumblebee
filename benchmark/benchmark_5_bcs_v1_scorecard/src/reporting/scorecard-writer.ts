import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  ArtifactStore,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  BCS_SCORECARD_CONTRACT_VERSION,
  type BcsScorecardAggregation,
  type BcsScorecardArtifacts,
  type BcsScorecardManifest,
  type BcsScorecardReport,
} from "../contracts/index.js";
import { renderBcsScorecardMarkdown } from "./markdown.js";

export interface WriteBcsScorecardOptions {
  readonly manifest: BcsScorecardManifest;
  readonly aggregation: BcsScorecardAggregation;
  readonly scoreSpecId: string;
  readonly outputDirectory: string;
  readonly clock?: () => Date;
  readonly scorecardIdFactory?: () => string;
}

export async function writeBcsScorecard(
  options: WriteBcsScorecardOptions,
): Promise<{
  readonly report: BcsScorecardReport;
  readonly artifacts: BcsScorecardArtifacts;
  readonly outputDirectory: string;
}> {
  const clock = options.clock ?? (() => new Date());
  const scorecardId = options.scorecardIdFactory?.() ??
    `scorecard_${Date.now().toString(36)}_${randomUUID()}`;
  const store = new ArtifactStore(options.outputDirectory, { clock });
  const sourceSnapshots = [];
  for (const source of options.aggregation.sources) {
    sourceSnapshots.push(await store.writeJson({
      runId: scorecardId,
      relativePath: `sources/${source.component}.json`,
      kind: "verifier",
      mediaType: "application/json",
      value: source,
    }));
  }

  const report: BcsScorecardReport = Object.freeze({
    contractVersion: BCS_SCORECARD_CONTRACT_VERSION,
    scorecardId,
    manifestId: options.manifest.id,
    manifestVersion: options.manifest.version,
    scoreSpec: options.scoreSpecId,
    generatedAt: clock().toISOString(),
    qualification: options.aggregation.qualification,
    reasons: options.aggregation.reasons,
    metrics: options.aggregation.metrics,
    gateEvaluation: options.aggregation.gateEvaluation,
    score: options.aggregation.score,
    sources: options.aggregation.sources,
  });
  const reportArtifact = await store.writeJson({
    runId: scorecardId,
    relativePath: "report.json",
    kind: "report",
    mediaType: "application/json",
    value: report,
  });
  const markdownArtifact = await store.writeRaw({
    runId: scorecardId,
    relativePath: "report.md",
    kind: "report",
    mediaType: "text/markdown; charset=utf-8",
    content: renderBcsScorecardMarkdown(report),
  });

  return Object.freeze({
    report,
    artifacts: Object.freeze({
      report: reportArtifact,
      markdown: markdownArtifact,
      sourceSnapshots: Object.freeze(sourceSnapshots),
    }),
    outputDirectory: path.resolve(options.outputDirectory),
  });
}
