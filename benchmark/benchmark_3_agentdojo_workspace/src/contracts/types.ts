import type {
  EvaluationFailure,
  GateEvaluation,
  QualificationStatus,
  ScoreSpec,
  TokenUsage,
} from "../../../benchmark_0_evaluation_core/src/index.js";

export const AGENTDOJO_CONTRACT_VERSION = 1 as const;

export const AGENTDOJO_COMPONENTS = [
  "Utility",
  "UtilityUnderAttack",
  "AttackResistance",
] as const;

export const AGENTDOJO_SUBJECT_PROFILES = [
  "pi-baseline",
  "bumblebee-full",
] as const;

export const AGENTDOJO_APPROVAL_POLICIES = [
  "allow-once",
  "deny",
] as const;

export const PI_INVOCATION_STATUSES = [
  "completed",
  "failed",
  "timed-out",
] as const;

export type AgentDojoComponent =
  (typeof AGENTDOJO_COMPONENTS)[number];
export type AgentDojoSubjectProfile =
  (typeof AGENTDOJO_SUBJECT_PROFILES)[number];
export type AgentDojoApprovalPolicy =
  (typeof AGENTDOJO_APPROVAL_POLICIES)[number];
export type PiInvocationStatus =
  (typeof PI_INVOCATION_STATUSES)[number];

export interface AgentDojoDatasetConfig {
  readonly package: "agentdojo";
  readonly packageVersion: string;
  readonly benchmarkVersion: string;
  readonly suite: "workspace";
  readonly attack: string;
  readonly reference: string;
  readonly pinning: "runtime-content-sha256";
}

export interface AgentDojoAgentConfig {
  readonly baseline: "pi-baseline";
  readonly candidate: "bumblebee-full";
  readonly piPackage: "@earendil-works/pi-coding-agent";
  readonly piVersion: string;
  readonly extensionSourcePrefix: string;
}

export interface AgentDojoBridgeConfig {
  readonly protocolVersion: 1;
  readonly approvalPolicy: AgentDojoApprovalPolicy;
  readonly taskTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly systemPrompt: string;
}

export interface AgentDojoManifest {
  readonly contractVersion: typeof AGENTDOJO_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly dataset: AgentDojoDatasetConfig;
  readonly agents: AgentDojoAgentConfig;
  readonly bridge: AgentDojoBridgeConfig;
  readonly scoreSpec: ScoreSpec;
}

export interface AgentDojoModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel?: string;
}

export interface AgentDojoSubjectIdentity {
  readonly profile: AgentDojoSubjectProfile;
  readonly piVersion: string;
  readonly bumblebeeCommit?: string;
  readonly extensionSource?: string;
  readonly workspaceClean: boolean;
}

export interface AgentDojoDatasetIdentity {
  readonly package: string;
  readonly packageVersion: string;
  readonly benchmarkVersion: string;
  readonly suite: string;
  readonly attack: string;
  readonly contentSha256: string;
  readonly userTaskCount: number;
  readonly injectionTaskCount: number;
  readonly toolCount: number;
}

export interface AgentDojoSelection {
  readonly userTaskIds: readonly string[];
  readonly injectionTaskIds: readonly string[];
}

export interface AgentDojoCleanCase {
  readonly userTaskId: string;
  readonly utility: boolean;
}

export interface AgentDojoAttackCase {
  readonly userTaskId: string;
  readonly injectionTaskId: string;
  readonly utility: boolean;
  readonly security: boolean;
}

export interface AgentDojoInjectionUtilityCase {
  readonly injectionTaskId: string;
  readonly utility: boolean;
}

export interface PiInvocationTrace {
  readonly invocationId: string;
  readonly querySha256: string;
  readonly status: PiInvocationStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly toolCallCount: number;
  readonly permissionPromptCount: number;
  readonly tokens?: TokenUsage;
  readonly costUsd?: number;
  readonly failure?: EvaluationFailure;
}

export interface AgentDojoBridgeIdentity {
  readonly protocolVersion: number;
  readonly approvalPolicy: AgentDojoApprovalPolicy;
  readonly systemPromptSha256: string;
  readonly maxResponseBytes: number;
}

export interface AgentDojoResultProvenance {
  readonly sourceSha256: string;
  readonly sourceFileName: string;
}

export interface NormalizedAgentDojoRun {
  readonly contractVersion: typeof AGENTDOJO_CONTRACT_VERSION;
  readonly adapterRunId: string;
  readonly adapterVersion: string;
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly dataset: AgentDojoDatasetIdentity;
  readonly subject: AgentDojoSubjectIdentity;
  readonly model: AgentDojoModelIdentity;
  readonly bridge: AgentDojoBridgeIdentity;
  readonly selection: AgentDojoSelection;
  readonly cleanCases: readonly AgentDojoCleanCase[];
  readonly attackCases: readonly AgentDojoAttackCase[];
  readonly injectionUtilityCases:
    readonly AgentDojoInjectionUtilityCase[];
  readonly traces: readonly PiInvocationTrace[];
  readonly failure?: EvaluationFailure;
  readonly provenance: AgentDojoResultProvenance;
}

export interface AgentDojoScoreFactor {
  readonly id: AgentDojoComponent;
  readonly score: number;
  readonly weight: number;
  readonly factor: number;
}

export interface AgentDojoGeometricScore {
  readonly contractVersion: typeof AGENTDOJO_CONTRACT_VERSION;
  readonly scoreSpec: string;
  readonly qualification: QualificationStatus;
  readonly score: number | null;
  readonly factors: readonly AgentDojoScoreFactor[];
}

export interface AgentDojoAggregation {
  readonly metrics: Readonly<Record<string, number>>;
  readonly componentScores: Readonly<
    Record<AgentDojoComponent, number>
  >;
  readonly gateEvaluation: GateEvaluation;
  readonly score: AgentDojoGeometricScore;
}

export interface AgentDojoReport {
  readonly contractVersion: typeof AGENTDOJO_CONTRACT_VERSION;
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly adapterRunId: string;
  readonly generatedAt: string;
  readonly datasetHash: string;
  readonly subject: AgentDojoSubjectIdentity;
  readonly model: AgentDojoModelIdentity;
  readonly cleanCaseCount: number;
  readonly attackCaseCount: number;
  readonly componentScores: Readonly<
    Record<AgentDojoComponent, number>
  >;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: AgentDojoGeometricScore;
  readonly provenance: AgentDojoResultProvenance;
}

export interface AgentDojoRunPlan {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly displayCommand: string;
}
