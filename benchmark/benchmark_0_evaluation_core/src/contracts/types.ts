import type { JsonObject } from "../../../../src/foundation/index.js";

export const EVALUATION_CONTRACT_VERSION = 1 as const;

export const TASK_STATUSES = [
  "passed",
  "failed",
  "cancelled",
  "invalid",
] as const;

export const RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "invalid",
] as const;

export const FAILURE_CATEGORIES = [
  "bumblebee",
  "model",
  "adapter",
  "infrastructure",
  "dataset",
  "expected-policy",
] as const;

export const SUITE_SPLITS = [
  "dev",
  "holdout",
  "release",
] as const;

export const ARTIFACT_KINDS = [
  "manifest",
  "task-result",
  "trajectory",
  "verifier",
  "summary",
  "report",
  "other",
] as const;

export const GATE_KINDS = [
  "validity",
  "qualification",
] as const;

export const GATE_OPERATORS = [
  "eq",
  "gte",
  "lte",
] as const;

export const LESSON_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type EvaluationRunStatus = (typeof RUN_STATUSES)[number];
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export type SuiteSplit = (typeof SUITE_SPLITS)[number];
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type GateKind = (typeof GATE_KINDS)[number];
export type GateOperator = (typeof GATE_OPERATORS)[number];
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export type QualificationStatus =
  | "qualified"
  | "not-qualified"
  | "invalid";

export interface SuiteIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly split: SuiteSplit;
  readonly datasetHash: string;
}

export interface SubjectIdentity {
  readonly bumblebeeCommit: string;
  readonly workspaceClean: boolean;
  readonly piVersion: string;
}

export interface EnvironmentIdentity {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly hardwareProfile: string;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly thinkingLevel?: string;
}

export interface EvaluationBudget {
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}

export interface StartEvaluationRunInput {
  readonly parentRunId?: string;
  readonly scoreSpec: string;
  readonly suite: SuiteIdentity;
  readonly subject: SubjectIdentity;
  readonly environment: EnvironmentIdentity;
  readonly model?: ModelIdentity;
  readonly budget: EvaluationBudget;
  readonly repetitions: number;
  readonly startedAt?: string;
  readonly metadata?: JsonObject;
}

export interface EvaluationRunManifest {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly scoreSpec: string;
  readonly suite: SuiteIdentity;
  readonly subject: SubjectIdentity;
  readonly environment: EnvironmentIdentity;
  readonly model?: ModelIdentity;
  readonly budget: EvaluationBudget;
  readonly repetitions: number;
  readonly startedAt: string;
  readonly metadata?: JsonObject;
}

export interface ArtifactReference {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly artifactId: string;
  readonly runId: string;
  readonly relativePath: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly sanitized: boolean;
}

export interface ArtifactVerification {
  readonly valid: boolean;
  readonly expectedSha256: string;
  readonly actualSha256?: string;
  readonly expectedByteLength: number;
  readonly actualByteLength?: number;
  readonly reason?: "missing" | "size-mismatch" | "hash-mismatch";
}

export interface EvaluationFailure {
  readonly category: FailureCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface EvaluationTaskResultInput {
  readonly taskId: string;
  readonly trial: number;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly reward?: number;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly tokens?: TokenUsage;
  readonly costUsd?: number;
  readonly failure?: EvaluationFailure;
  readonly artifacts?: readonly ArtifactReference[];
  readonly metadata?: JsonObject;
}

export interface EvaluationTaskResult extends EvaluationTaskResultInput {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly runId: string;
  readonly recordedAt: string;
}

export interface GateDefinition {
  readonly id: string;
  readonly kind: GateKind;
  readonly metric: string;
  readonly operator: GateOperator;
  readonly threshold: number;
}

export interface ScoreComponentDefinition {
  readonly id: string;
  readonly weight: number;
}

export interface ScoreSpec {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly id: string;
  readonly components: readonly ScoreComponentDefinition[];
  readonly hardGates: readonly GateDefinition[];
}

export interface GateDecision {
  readonly gateId: string;
  readonly kind: GateKind;
  readonly metric: string;
  readonly operator: GateOperator;
  readonly threshold: number;
  readonly actual?: number;
  readonly status: "passed" | "failed" | "missing";
}

export interface GateEvaluation {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly scoreSpec: string;
  readonly status: QualificationStatus;
  readonly decisions: readonly GateDecision[];
}

export interface ComponentContribution {
  readonly id: string;
  readonly score: number;
  readonly weight: number;
  readonly contribution: number;
}

export interface CompositeScore {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly scoreSpec: string;
  readonly qualification: QualificationStatus;
  readonly score: number | null;
  readonly components: readonly ComponentContribution[];
}

export interface EvaluationTaskCounts {
  readonly passed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly invalid: number;
  readonly total: number;
}

export interface FinalizeEvaluationRunInput {
  readonly status: EvaluationRunStatus;
  readonly finishedAt?: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly compositeScore?: CompositeScore;
  readonly failure?: EvaluationFailure;
  readonly lessonIds?: readonly string[];
}

export interface EvaluationRunSummary {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly scoreSpec: string;
  readonly status: EvaluationRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly taskCounts: EvaluationTaskCounts;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly compositeScore?: CompositeScore;
  readonly failure?: EvaluationFailure;
  readonly lessonIds: readonly string[];
  readonly taskResultArtifacts: readonly ArtifactReference[];
}

export interface RunStartedLedgerEntry {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly event: "run_started";
  readonly runId: string;
  readonly parentRunId?: string;
  readonly at: string;
  readonly manifestArtifact: ArtifactReference;
}

export interface RunFinishedLedgerEntry {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly event: "run_finished";
  readonly runId: string;
  readonly at: string;
  readonly status: EvaluationRunStatus;
  readonly qualification: QualificationStatus;
  readonly taskCounts: EvaluationTaskCounts;
  readonly summaryArtifact: ArtifactReference;
}

export type RunLedgerEntry =
  | RunStartedLedgerEntry
  | RunFinishedLedgerEntry;

export type LessonCategory = FailureCategory | "success-pattern";

export interface LessonRevisionInput {
  readonly lessonId: string;
  readonly title: string;
  readonly category: LessonCategory;
  readonly status: LessonStatus;
  readonly evidenceRunIds: readonly string[];
  readonly evidence: string;
  readonly hypothesis: string;
  readonly changeBoundary: string;
  readonly expectedMetrics: readonly string[];
  readonly risks: readonly string[];
  readonly developmentResult?: string;
  readonly holdoutResult?: string;
  readonly relatedCommit?: string;
  readonly verificationRunIds?: readonly string[];
}

export interface LessonRevision extends LessonRevisionInput {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly revision: number;
  readonly recordedAt: string;
}
