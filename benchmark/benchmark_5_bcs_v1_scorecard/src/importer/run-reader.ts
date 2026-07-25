import path from "node:path";

import {
  type BcsSourceDefinition,
  type ImportedBcsRun,
  invalid,
} from "../contracts/index.js";
import {
  openVerifiedRunArtifacts,
  readJsonFile,
  verifyTaskArtifactReferences,
} from "./artifact-integrity.js";
import {
  parseRunManifest,
  parseRunSummary,
} from "./run-parser.js";
import {
  assertSourceContract,
  deriveSourceScore,
} from "./source-contract.js";

/**
 * 只接受 Benchmark 0 的标准运行目录。manifest、summary 和逐任务结果
 * 都会使用 ledger 中的 SHA-256 引用重新校验，避免聚合被手工改写的分数。
 */
export async function readBcsSourceRun(
  definition: BcsSourceDefinition,
  inputDirectory: string,
): Promise<ImportedBcsRun> {
  const layout = await openVerifiedRunArtifacts(inputDirectory);
  const manifest = parseRunManifest(
    await readJsonFile(
      path.join(layout.sourceDirectory, "manifest.json"),
    ),
  );
  const summary = parseRunSummary(
    await readJsonFile(
      path.join(layout.sourceDirectory, "summary.json"),
    ),
  );
  assertSourceContract(
    definition,
    layout.runId,
    manifest,
    summary,
  );

  if (
    layout.ledgerStatus !== summary.status ||
    layout.ledgerQualification !== summary.gateEvaluation.status
  ) {
    invalid("run ledger contradicts the source summary", {
      component: definition.id,
      runId: layout.runId,
    });
  }
  await verifyTaskArtifactReferences(
    layout,
    summary.taskResultArtifacts,
    summary.taskCounts.total,
    definition.id,
  );

  const derived = deriveSourceScore(definition, summary);
  return Object.freeze({
    component: definition.id,
    sourceDirectory: layout.sourceDirectory,
    manifest,
    summary,
    manifestReference: layout.manifestReference,
    summaryReference: layout.summaryReference,
    score: derived.score,
    qualification: derived.qualification,
  });
}
