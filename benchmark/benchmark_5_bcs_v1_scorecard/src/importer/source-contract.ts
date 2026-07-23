import type {
  EvaluationRunManifest,
  EvaluationRunSummary,
  QualificationStatus,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  type BcsSourceDefinition,
  invalid,
} from "../contracts/index.js";

export function assertSourceContract(
  definition: BcsSourceDefinition,
  runId: string,
  manifest: EvaluationRunManifest,
  summary: EvaluationRunSummary,
): void {
  if (
    manifest.runId !== runId ||
    summary.runId !== runId ||
    manifest.scoreSpec !== definition.scoreSpec ||
    summary.scoreSpec !== definition.scoreSpec ||
    summary.gateEvaluation.scoreSpec !== definition.scoreSpec ||
    manifest.suite.id !== definition.suiteId ||
    manifest.suite.version !== definition.suiteVersion ||
    manifest.suite.split !== definition.suiteSplit
  ) {
    invalid("source run identity does not match its BCS component", {
      component: definition.id,
      runId,
    });
  }
  for (const [key, expected] of Object.entries(
    definition.requiredMetadata,
  )) {
    if (manifest.metadata?.[key] !== expected) {
      invalid("source run does not use the formal benchmark profile", {
        component: definition.id,
        key,
        expected,
      });
    }
  }
  if (
    summary.compositeScore !== undefined &&
    (
      summary.compositeScore.scoreSpec !== definition.scoreSpec ||
      summary.compositeScore.qualification !==
        summary.gateEvaluation.status
    )
  ) {
    invalid("source composite score contradicts its gate evaluation", {
      component: definition.id,
    });
  }
}

export function deriveSourceScore(
  definition: BcsSourceDefinition,
  summary: EvaluationRunSummary,
): {
  readonly score: number | null;
  readonly qualification: QualificationStatus;
} {
  if (definition.scoreSource.kind === "composite") {
    const composite = summary.compositeScore;
    if (composite === undefined) {
      invalid("source summary does not contain its composite score", {
        component: definition.id,
      });
    }
    return Object.freeze({
      score: composite.score,
      qualification: composite.qualification,
    });
  }

  const qualification = summary.gateEvaluation.status;
  if (qualification !== "qualified") {
    return Object.freeze({ score: null, qualification });
  }
  let product = 1;
  for (const factor of definition.scoreSource.factors) {
    const metric = summary.metrics[factor.metric];
    if (
      metric === undefined ||
      !Number.isFinite(metric) ||
      metric < 0 ||
      metric > 1
    ) {
      invalid("geometric score metric must be between 0 and 1", {
        component: definition.id,
        metric: factor.metric,
      });
    }
    product *= Math.pow(metric, factor.weight);
  }
  return Object.freeze({
    score: round(100 * product),
    qualification,
  });
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
