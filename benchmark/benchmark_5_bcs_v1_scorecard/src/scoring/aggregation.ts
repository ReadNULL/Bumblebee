import {
  EVALUATION_CONTRACT_VERSION,
  calculateCompositeScore,
  evaluateHardGates,
  type CompositeScore,
  type ModelIdentity,
  type QualificationStatus,
  type ScoreSpec,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  BCS_COMPONENT_IDS,
  type BcsComponentId,
  type BcsGlobalMetricRule,
  type BcsScorecardAggregation,
  type BcsScorecardManifest,
  type BcsSourceReport,
  type ImportedBcsRun,
  invalid,
} from "../contracts/index.js";

const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;

export function aggregateBcsScorecard(
  manifest: BcsScorecardManifest,
  scoreSpec: ScoreSpec,
  importedRuns: readonly ImportedBcsRun[],
): BcsScorecardAggregation {
  const runs = indexRuns(importedRuns);
  const metrics = aggregateGlobalMetrics(
    manifest.globalMetricRules,
    runs,
  );
  const gateEvaluation = evaluateHardGates(scoreSpec, metrics);
  const sourceReports = manifest.components.map((definition) =>
    createSourceReport(runs.get(definition.id) as ImportedBcsRun)
  );
  const assessment = assessQualification(
    manifest,
    runs,
    gateEvaluation.status,
  );
  const componentScores = Object.fromEntries(
    BCS_COMPONENT_IDS.flatMap((component) => {
      const score = runs.get(component)?.score;
      return score === null || score === undefined
        ? []
        : [[component, score] as const];
    }),
  );
  const score = assessment.qualification === "qualified"
    ? calculateCompositeScore(
        scoreSpec,
        componentScores,
        gateEvaluation,
      )
    : createUnpublishedScore(
        scoreSpec.id,
        assessment.qualification,
      );

  return Object.freeze({
    qualification: assessment.qualification,
    reasons: Object.freeze(assessment.reasons),
    metrics,
    gateEvaluation,
    score,
    sources: Object.freeze(sourceReports),
  });
}

function indexRuns(
  runs: readonly ImportedBcsRun[],
): ReadonlyMap<BcsComponentId, ImportedBcsRun> {
  if (runs.length !== BCS_COMPONENT_IDS.length) {
    invalid("scorecard requires exactly four source runs", {
      actual: runs.length,
    });
  }
  const indexed = new Map<BcsComponentId, ImportedBcsRun>();
  for (const run of runs) {
    if (indexed.has(run.component)) {
      invalid("scorecard contains a duplicate source component", {
        component: run.component,
      });
    }
    indexed.set(run.component, run);
  }
  for (const component of BCS_COMPONENT_IDS) {
    if (!indexed.has(component)) {
      invalid("scorecard source component is missing", { component });
    }
  }
  return indexed;
}

function aggregateGlobalMetrics(
  rules: readonly BcsGlobalMetricRule[],
  runs: ReadonlyMap<BcsComponentId, ImportedBcsRun>,
): Readonly<Record<string, number>> {
  const metrics: Record<string, number> = {};
  for (const rule of rules) {
    const value = aggregateMetricRule(rule, runs);
    if (value !== undefined) {
      metrics[rule.metric] = round(value);
    }
  }
  return Object.freeze(metrics);
}

function aggregateMetricRule(
  rule: BcsGlobalMetricRule,
  runs: ReadonlyMap<BcsComponentId, ImportedBcsRun>,
): number | undefined {
  if (rule.aggregation === "task-valid-rate") {
    const counts = rule.components.map(
      (component) => (runs.get(component) as ImportedBcsRun).summary
        .taskCounts,
    );
    const total = counts.reduce(
      (sum, item) => sum + item.total,
      0,
    );
    if (total === 0) {
      return undefined;
    }
    const valid = counts.reduce(
      (sum, item) => sum + item.passed + item.failed,
      0,
    );
    return valid / total;
  }

  const values = rule.components.map(
    (component) =>
      (runs.get(component) as ImportedBcsRun).summary.metrics[
        rule.metric
      ],
  );
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  const complete = values as number[];
  return rule.aggregation === "value"
    ? complete[0]
    : complete.reduce((sum, value) => sum + value, 0);
}

function assessQualification(
  manifest: BcsScorecardManifest,
  runs: ReadonlyMap<BcsComponentId, ImportedBcsRun>,
  gateStatus: QualificationStatus,
): {
  readonly qualification: QualificationStatus;
  readonly reasons: string[];
} {
  let qualification: QualificationStatus = "qualified";
  const reasons: string[] = [];
  const mark = (
    status: Exclude<QualificationStatus, "qualified">,
    reason: string,
  ) => {
    reasons.push(reason);
    qualification = highestSeverity(qualification, status);
  };

  for (const component of BCS_COMPONENT_IDS) {
    const run = runs.get(component) as ImportedBcsRun;
    if (run.summary.status !== "completed") {
      mark(
        "invalid",
        `source.${component}.run-status:${run.summary.status}`,
      );
    }
    if (run.qualification === "invalid") {
      mark("invalid", `source.${component}.qualification:invalid`);
    } else if (run.qualification === "not-qualified") {
      mark(
        "not-qualified",
        `source.${component}.qualification:not-qualified`,
      );
    }
    if (
      manifest.identityPolicy.requireCleanWorkspace &&
      !run.manifest.subject.workspaceClean
    ) {
      mark("not-qualified", `source.${component}.workspace:dirty`);
    }
  }

  assessSharedSubject(manifest, runs, mark);
  if (gateStatus === "invalid") {
    mark("invalid", "bcs.gates:invalid");
  } else if (gateStatus === "not-qualified") {
    mark("not-qualified", "bcs.gates:not-qualified");
  }

  return {
    qualification,
    reasons: [...new Set(reasons)],
  };
}

function assessSharedSubject(
  manifest: BcsScorecardManifest,
  runs: ReadonlyMap<BcsComponentId, ImportedBcsRun>,
  mark: (
    status: Exclude<QualificationStatus, "qualified">,
    reason: string,
  ) => void,
): void {
  const allRuns = BCS_COMPONENT_IDS.map(
    (component) => runs.get(component) as ImportedBcsRun,
  );
  const commits = new Set(
    allRuns.map((run) => run.manifest.subject.bumblebeeCommit),
  );
  if (
    manifest.identityPolicy.requireSameBumblebeeCommit &&
    (
      commits.size !== 1 ||
      [...commits].some((commit) => !COMMIT_PATTERN.test(commit))
    )
  ) {
    mark("invalid", "identity.bumblebee-commit:mismatch-or-unpinned");
  }

  const piVersions = new Set(
    allRuns.map((run) => run.manifest.subject.piVersion),
  );
  if (
    manifest.identityPolicy.requireSamePiVersion &&
    piVersions.size !== 1
  ) {
    mark("invalid", "identity.pi-version:mismatch");
  }

  const modelRuns = manifest.identityPolicy.sameModelComponents.map(
    (component) => runs.get(component) as ImportedBcsRun,
  );
  const models = modelRuns.map((run) => run.manifest.model);
  if (
    models.some((model) => model === undefined) ||
    new Set(
      (models as ModelIdentity[]).map(modelKey),
    ).size !== 1
  ) {
    mark("invalid", "identity.model:mismatch-or-missing");
  }
}

function createSourceReport(run: ImportedBcsRun): BcsSourceReport {
  return Object.freeze({
    component: run.component,
    runId: run.manifest.runId,
    suiteId: run.manifest.suite.id,
    suiteVersion: run.manifest.suite.version,
    datasetHash: run.manifest.suite.datasetHash,
    scoreSpec: run.manifest.scoreSpec,
    status: run.summary.status,
    qualification: run.qualification,
    score: run.score,
    subject: run.manifest.subject,
    environment: run.manifest.environment,
    ...(run.manifest.model === undefined
      ? {}
      : { model: run.manifest.model }),
    taskCounts: run.summary.taskCounts,
    manifestSha256: run.manifestReference.sha256,
    summarySha256: run.summaryReference.sha256,
  });
}

function createUnpublishedScore(
  scoreSpec: string,
  qualification: Exclude<QualificationStatus, "qualified">,
): CompositeScore {
  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec,
    qualification,
    score: null,
    components: Object.freeze([]),
  });
}

function highestSeverity(
  current: QualificationStatus,
  next: Exclude<QualificationStatus, "qualified">,
): QualificationStatus {
  return current === "invalid" || next === "invalid"
    ? "invalid"
    : "not-qualified";
}

function modelKey(model: ModelIdentity): string {
  return JSON.stringify([
    model.provider,
    model.id,
    model.thinkingLevel ?? null,
  ]);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) /
    1_000_000;
}
