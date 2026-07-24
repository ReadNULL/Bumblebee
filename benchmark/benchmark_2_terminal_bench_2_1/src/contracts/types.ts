import type {
  CompositeScore,
  EvaluationFailure,
  GateEvaluation,
  ScoreSpec,
  TaskStatus,
  TokenUsage,
} from "../../../benchmark_0_evaluation_core/src/index.js";

export const TERMINAL_BENCH_CONTRACT_VERSION = 1 as const;

export const TERMINAL_BENCH_COMPONENTS = [
  "OfficialReward",
  "CostEfficiency",
  "LatencyEfficiency",
  "Stability",
] as const;

export type TerminalBenchComponent =
  (typeof TERMINAL_BENCH_COMPONENTS)[number];

export type TerminalBenchTaskDifficulty =
  | "easy"
  | "medium"
  | "hard";

export interface TerminalBenchSelectedTask {
  readonly id: string;
  readonly category: string;
  readonly difficulty: TerminalBenchTaskDifficulty;
  readonly capability: string;
}

export interface TerminalBenchDatasetConfig {
  readonly id: string;
  readonly reference: string;
  readonly pinning: "resolved-task-checksums";
  readonly sourceTaskCount: number;
  readonly samplingFraction: number;
  readonly selectionMethod: "frozen-stratified-subset";
  readonly expectedTaskCount: number;
  readonly minimumTrialsPerTask: number;
  readonly selectedTasks: readonly TerminalBenchSelectedTask[];
}

export interface TerminalBenchAgentConfig {
  readonly baseline: string;
  readonly candidate: string;
  readonly piPackage: string;
  readonly piVersion: string;
  readonly extensionSourcePrefix: string;
}

export interface TerminalBenchBaselineConfig {
  readonly requiredRuns: number;
  readonly minimumSamplesPerTask: number;
  readonly estimator: "median";
}

export interface TerminalBenchManifest {
  readonly contractVersion: typeof TERMINAL_BENCH_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly dataset: TerminalBenchDatasetConfig;
  readonly agents: TerminalBenchAgentConfig;
  readonly baseline: TerminalBenchBaselineConfig;
  readonly rewardKey: string;
  readonly scoreSpec: ScoreSpec;
}

export interface HarborIdentity {
  readonly agentName: string;
  readonly agentVersion: string;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly thinkingLevel?: string;
}

export interface NormalizedTerminalBenchTrial {
  readonly jobId: string;
  readonly harborTrialId: string;
  readonly taskId: string;
  readonly taskChecksum: string;
  readonly trialName: string;
  readonly trial: number;
  readonly datasetId: string;
  readonly datasetReference: string;
  readonly identity: HarborIdentity;
  readonly extensionSource?: string;
  readonly extensionCommit?: string;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly agentDurationMs: number;
  readonly reward?: number;
  readonly tokens?: TokenUsage;
  readonly costUsd?: number;
  readonly stable: boolean;
  readonly failure?: EvaluationFailure;
}

export interface HarborJobProvenance {
  readonly configSha256: string;
  readonly resultSha256: string;
  readonly trialResultsSha256: string;
  readonly sourceDirectoryName: string;
}

export interface NormalizedTerminalBenchJob {
  readonly contractVersion: typeof TERMINAL_BENCH_CONTRACT_VERSION;
  readonly jobId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly nTotalTrials: number;
  readonly concurrency: number;
  readonly environmentType: string;
  readonly datasetId: string;
  readonly datasetReference: string;
  readonly datasetHash: string;
  readonly trials: readonly NormalizedTerminalBenchTrial[];
  readonly provenance: HarborJobProvenance;
}

export interface TerminalBenchTaskBudget {
  readonly taskId: string;
  readonly taskChecksum: string;
  readonly costUsd: number;
  readonly agentDurationMs: number;
  readonly costSampleCount: number;
  readonly durationSampleCount: number;
}

export interface TerminalBenchBudgetManifest {
  readonly contractVersion: typeof TERMINAL_BENCH_CONTRACT_VERSION;
  readonly id: string;
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly estimator: "median";
  readonly generatedAt: string;
  readonly sourceJobIds: readonly string[];
  readonly baselineIdentity: HarborIdentity;
  readonly taskBudgets: readonly TerminalBenchTaskBudget[];
}

export interface TerminalBenchAggregation {
  readonly metrics: Readonly<Record<string, number>>;
  readonly componentScores: Readonly<
    Record<TerminalBenchComponent, number>
  >;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
}

export interface TerminalBenchReport {
  readonly contractVersion: typeof TERMINAL_BENCH_CONTRACT_VERSION;
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly harborJobId: string;
  readonly generatedAt: string;
  readonly datasetHash: string;
  readonly trialCount: number;
  readonly componentScores: Readonly<
    Record<TerminalBenchComponent, number>
  >;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
  readonly provenance: HarborJobProvenance;
}

export type HarborRunMode = "baseline" | "candidate";

export interface HarborRunPlan {
  readonly executable: "python";
  readonly arguments: readonly string[];
  readonly displayCommand: string;
}
