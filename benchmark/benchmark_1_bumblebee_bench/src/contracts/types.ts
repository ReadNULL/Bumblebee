import type {
  CompositeScore,
  EvaluationFailure,
  GateEvaluation,
  ScoreSpec,
  TaskStatus,
} from "../../../benchmark_0_evaluation_core/src/index.js";

export const BUMBLEBEE_BENCH_CONTRACT_VERSION = 1 as const;

export const BUMBLEBEE_BENCH_DOMAINS = [
  "Runtime",
  "Cancellation",
  "Permission",
  "SubAgent",
  "Channel",
  "MemoryCore",
] as const;

export const BUMBLEBEE_BENCH_PROFILES = [
  "smoke",
  "full",
] as const;

export type BumblebeeBenchDomain =
  (typeof BUMBLEBEE_BENCH_DOMAINS)[number];
export type BumblebeeBenchProfile =
  (typeof BUMBLEBEE_BENCH_PROFILES)[number];

export interface BumblebeeBenchProfileConfig {
  readonly repetitions: number;
}

export interface BumblebeeBenchScenarioConfig {
  readonly id: string;
  readonly description: string;
  readonly sloMs: number;
  readonly timeoutMs: number;
}

export interface BumblebeeBenchDomainConfig {
  readonly id: BumblebeeBenchDomain;
  readonly weight: number;
  readonly scenarios: readonly BumblebeeBenchScenarioConfig[];
}

export interface BumblebeeBenchManifest {
  readonly contractVersion:
    typeof BUMBLEBEE_BENCH_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly profiles: Readonly<
    Record<BumblebeeBenchProfile, BumblebeeBenchProfileConfig>
  >;
  readonly domains: readonly BumblebeeBenchDomainConfig[];
  readonly scoreSpec: ScoreSpec;
}

export interface ScenarioAssertion {
  readonly id: string;
  readonly passed: boolean;
}

export interface ScenarioObservation {
  readonly assertions: readonly ScenarioAssertion[];
  readonly metrics: Readonly<Record<string, number>>;
}

export interface ScenarioExecutionResult {
  readonly contractVersion:
    typeof BUMBLEBEE_BENCH_CONTRACT_VERSION;
  readonly scenarioId: string;
  readonly domain: BumblebeeBenchDomain;
  readonly trial: number;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly correctness: number;
  readonly sloCompliance: number;
  readonly reward: number;
  readonly assertions: readonly ScenarioAssertion[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly failure?: EvaluationFailure;
}

export interface DomainBenchmarkResult {
  readonly domain: BumblebeeBenchDomain;
  readonly scenarioCount: number;
  readonly trialCount: number;
  readonly correctness: number;
  readonly sloCompliance: number;
  readonly score: number;
  readonly durationMs: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
}

export interface BumblebeeBenchReport {
  readonly contractVersion:
    typeof BUMBLEBEE_BENCH_CONTRACT_VERSION;
  readonly runId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly profile: BumblebeeBenchProfile;
  readonly generatedAt: string;
  readonly scenarioResults: readonly ScenarioExecutionResult[];
  readonly domains: readonly DomainBenchmarkResult[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
}
