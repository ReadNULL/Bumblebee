import type {
  ArtifactReference,
  CompositeScore,
  EnvironmentIdentity,
  EvaluationRunManifest,
  EvaluationRunSummary,
  EvaluationTaskCounts,
  GateEvaluation,
  ModelIdentity,
  QualificationStatus,
  ScoreSpec,
  SubjectIdentity,
  SuiteSplit,
} from "../../../benchmark_0_evaluation_core/src/index.js";

export const BCS_SCORECARD_CONTRACT_VERSION = 1 as const;

export const BCS_COMPONENT_IDS = [
  "BB",
  "TB",
  "AD",
  "LM",
] as const;

export const BCS_METRIC_AGGREGATIONS = [
  "value",
  "sum",
  "task-valid-rate",
] as const;

export type BcsComponentId = (typeof BCS_COMPONENT_IDS)[number];
export type BcsMetricAggregation =
  (typeof BCS_METRIC_AGGREGATIONS)[number];

export interface CompositeScoreSource {
  readonly kind: "composite";
}

export interface GeometricMetricFactor {
  readonly metric: string;
  readonly weight: number;
}

export interface GeometricMetricsScoreSource {
  readonly kind: "geometric-metrics";
  readonly factors: readonly GeometricMetricFactor[];
}

export type BcsScoreSource =
  | CompositeScoreSource
  | GeometricMetricsScoreSource;

export interface BcsSourceDefinition {
  readonly id: BcsComponentId;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly scoreSpec: string;
  readonly suiteSplit: SuiteSplit;
  readonly requiredMetadata: Readonly<Record<string, string>>;
  readonly scoreSource: BcsScoreSource;
}

export interface BcsIdentityPolicy {
  readonly requireCleanWorkspace: boolean;
  readonly requireSameBumblebeeCommit: boolean;
  readonly requireSamePiVersion: boolean;
  readonly sameModelComponents: readonly BcsComponentId[];
}

export interface BcsGlobalMetricRule {
  readonly metric: string;
  readonly aggregation: BcsMetricAggregation;
  readonly components: readonly BcsComponentId[];
}

export interface BcsScorecardManifest {
  readonly contractVersion:
    typeof BCS_SCORECARD_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly scoreSpecFile: string;
  readonly components: readonly BcsSourceDefinition[];
  readonly identityPolicy: BcsIdentityPolicy;
  readonly globalMetricRules: readonly BcsGlobalMetricRule[];
}

export interface BcsScorecardResources {
  readonly manifest: BcsScorecardManifest;
  readonly scoreSpec: ScoreSpec;
}

export interface ImportedBcsRun {
  readonly component: BcsComponentId;
  readonly sourceDirectory: string;
  readonly manifest: EvaluationRunManifest;
  readonly summary: EvaluationRunSummary;
  readonly manifestReference: ArtifactReference;
  readonly summaryReference: ArtifactReference;
  readonly score: number | null;
  readonly qualification: QualificationStatus;
}

export interface BcsSourceReport {
  readonly component: BcsComponentId;
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly datasetHash: string;
  readonly scoreSpec: string;
  readonly status: EvaluationRunSummary["status"];
  readonly qualification: QualificationStatus;
  readonly score: number | null;
  readonly subject: SubjectIdentity;
  readonly environment: EnvironmentIdentity;
  readonly model?: ModelIdentity;
  readonly taskCounts: EvaluationTaskCounts;
  readonly manifestSha256: string;
  readonly summarySha256: string;
}

export interface BcsScorecardAggregation {
  readonly qualification: QualificationStatus;
  readonly reasons: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
  readonly sources: readonly BcsSourceReport[];
}

export interface BcsScorecardReport {
  readonly contractVersion:
    typeof BCS_SCORECARD_CONTRACT_VERSION;
  readonly scorecardId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly scoreSpec: string;
  readonly generatedAt: string;
  readonly qualification: QualificationStatus;
  readonly reasons: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
  readonly sources: readonly BcsSourceReport[];
}

export interface BcsScorecardArtifacts {
  readonly report: ArtifactReference;
  readonly markdown: ArtifactReference;
  readonly sourceSnapshots: readonly ArtifactReference[];
}

export interface BcsScorecardRunResult {
  readonly report: BcsScorecardReport;
  readonly artifacts: BcsScorecardArtifacts;
  readonly outputDirectory: string;
}
