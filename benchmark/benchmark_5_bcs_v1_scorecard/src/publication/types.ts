import type {
  CompositeScore,
  EvaluationTaskCounts,
  GateEvaluation,
  ModelIdentity,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import type {
  BcsComponentId,
} from "../contracts/index.js";

export const BCS_PUBLICATION_CONTRACT_VERSION = 1 as const;

export interface PublishedRunEvidence {
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly qualification: "qualified";
  readonly bumblebeeCommit: string;
  readonly piVersion: string;
  readonly workspaceClean: true;
  readonly model?: ModelIdentity;
  readonly manifestSha256: string;
  readonly summarySha256: string;
}

export interface PublishedStandardComponent {
  readonly id: Exclude<BcsComponentId, "TB">;
  readonly mode: "standard-run";
  readonly score: number;
  readonly taskCounts: EvaluationTaskCounts;
  readonly metrics: Readonly<Record<string, number>>;
  readonly evidence: PublishedRunEvidence;
}

export interface PublishedTerminalSourceJob {
  readonly name: string;
  readonly harborJobId: string;
  readonly bumblebeeCommit: string;
  readonly completedTrials: number;
  readonly passed: number;
  readonly failed: number;
  readonly invalid: number;
  readonly configSha256: string;
  readonly resultSha256: string;
  readonly trialResultsSha256: string;
}

export interface PublishedTerminalBatch {
  readonly taskId: string;
  readonly sourceJob: string;
  readonly passed: number;
  readonly failed: number;
  readonly invalid: number;
  readonly invalidCategory?: "infrastructure";
  readonly invalidReason?: string;
}

export interface PublishedTerminalComponent {
  readonly id: "TB";
  readonly mode: "environment-recovery-aggregate";
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly piVersion: string;
  readonly model: ModelIdentity;
  readonly sourceJobs: readonly PublishedTerminalSourceJob[];
  readonly selectedBatches: readonly PublishedTerminalBatch[];
}

export type BcsPublishedComponent =
  | PublishedStandardComponent
  | PublishedTerminalComponent;

export interface BcsEnvironmentRecoveryPublication {
  readonly contractVersion:
    typeof BCS_PUBLICATION_CONTRACT_VERSION;
  readonly id: string;
  readonly scoreSpec: "bcs-v1";
  readonly publicationMode: "environment-recovery-aggregate";
  readonly reason: string;
  readonly components: readonly BcsPublishedComponent[];
}

export interface PublishedComponentResult {
  readonly id: BcsComponentId;
  readonly mode:
    | "standard-run"
    | "environment-recovery-aggregate";
  readonly score: number;
  readonly taskCounts: EvaluationTaskCounts;
}

export interface BcsEnvironmentRecoveryResult {
  readonly publicationId: string;
  readonly publicationMode: "environment-recovery-aggregate";
  readonly reason: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
  readonly components: readonly PublishedComponentResult[];
}
