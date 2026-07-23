import type {
  ErrorCode,
  JsonObject,
} from "../../../../src/foundation/index.js";
import type {
  MemoryAccessMode,
  MemoryMutationResult,
  MemoryScopeFilter,
  MemoryUpsertInput,
} from "../../../../src/memory/index.js";
import type {
  CompositeScore,
  GateEvaluation,
  ScoreSpec,
  TokenUsage,
} from "../../../benchmark_0_evaluation_core/src/index.js";

export const LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION = 1 as const;

export const LONGMEMEVAL_CAPABILITIES = [
  "information-extraction",
  "multi-session-reasoning",
  "knowledge-update",
  "temporal-reasoning",
  "abstention",
  "isolation",
] as const;

export const LONGMEMEVAL_PROFILES = [
  "memory-core",
  "bumblebee-full",
] as const;

export type LongMemEvalCapability =
  (typeof LONGMEMEVAL_CAPABILITIES)[number];
export type LongMemEvalProfile =
  (typeof LONGMEMEVAL_PROFILES)[number];

export interface LongMemEvalDatasetOrigin {
  readonly benchmark: "LongMemEval";
  readonly reference: string;
  readonly relationship: "capability-inspired-project-authored";
  readonly officialLeaderboardCompatible: false;
}

export interface LongMemEvalUpsertEvent {
  readonly type: "upsert";
  readonly at: string;
  readonly workspace: string;
  readonly input: MemoryUpsertInput;
  readonly expectedStatus: MemoryMutationResult["status"];
}

export interface LongMemEvalRejectUpsertEvent {
  readonly type: "reject-upsert";
  readonly at: string;
  readonly workspace: string;
  readonly input: MemoryUpsertInput;
  readonly expectedErrorCode: ErrorCode;
}

export type LongMemEvalLifecycleEvent =
  | {
      readonly type: "compact";
      readonly at: string;
      readonly workspace: string;
    }
  | {
      readonly type: "resume";
      readonly at: string;
      readonly workspace: string;
    };

export type LongMemEvalMemoryEvent =
  | LongMemEvalUpsertEvent
  | LongMemEvalRejectUpsertEvent
  | LongMemEvalLifecycleEvent;

export interface LongMemEvalQuery {
  readonly workspace: string;
  readonly text: string;
  readonly scope: MemoryScopeFilter;
  readonly access: MemoryAccessMode;
  readonly relevantKeys: readonly string[];
  readonly forbiddenKeys: readonly string[];
}

export interface LongMemEvalAnswerRubric {
  readonly requiredGroups: readonly (readonly string[])[];
  readonly forbiddenTerms: readonly string[];
  readonly abstain: boolean;
}

export interface LongMemEvalExpectedRecord {
  readonly workspace: string;
  readonly scope: MemoryUpsertInput["scope"];
  readonly key: string;
  readonly content: string;
  readonly revision: number;
}

export interface LongMemEvalUpdateCheck {
  readonly records: readonly LongMemEvalExpectedRecord[];
  readonly forbiddenPersistedTerms: readonly string[];
}

export interface LongMemEvalIsolationCheck {
  readonly forbiddenContextTerms: readonly string[];
  readonly requireReadOnlyPolicy: boolean;
}

export interface LongMemEvalCaseChecks {
  readonly update?: LongMemEvalUpdateCheck;
  readonly isolation?: LongMemEvalIsolationCheck;
  readonly forbiddenPersistedTerms?: readonly string[];
}

export interface LongMemEvalCase {
  readonly id: string;
  readonly capability: LongMemEvalCapability;
  readonly description: string;
  readonly workspaces: readonly string[];
  readonly events: readonly LongMemEvalMemoryEvent[];
  readonly query: LongMemEvalQuery;
  readonly answer: LongMemEvalAnswerRubric;
  readonly checks?: LongMemEvalCaseChecks;
}

export interface LongMemEvalDataset {
  readonly contractVersion:
    typeof LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly origin: LongMemEvalDatasetOrigin;
  readonly cases: readonly LongMemEvalCase[];
}

export interface LongMemEvalDatasetManifest {
  readonly file: string;
  readonly sha256: string;
  readonly caseCount: number;
  readonly capabilities: readonly LongMemEvalCapability[];
  readonly reference: string;
  readonly derivation: "project-authored";
}

export interface LongMemEvalProfileDefinition {
  readonly reader: "none" | "pi";
  readonly repetitions: number;
  readonly formal: boolean;
}

export interface LongMemEvalReaderDefinition {
  readonly piPackage: "@earendil-works/pi-coding-agent";
  readonly piVersion: string;
  readonly taskTimeoutMs: number;
  readonly systemPrompt: string;
}

export interface LongMemEvalAggregationDefinition {
  readonly qaAccuracy: "capability-macro";
  readonly recallAt5: "applicable-capability-macro";
  readonly precisionAt5: "applicable-capability-macro";
  readonly updateAccuracy: "applicable-capability-macro";
  readonly abstentionF1: "global-binary-f1";
  readonly isolationAccuracy: "applicable-capability-macro";
}

export interface LongMemEvalManifest {
  readonly contractVersion:
    typeof LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly dataset: LongMemEvalDatasetManifest;
  readonly profiles: Readonly<
    Record<LongMemEvalProfile, LongMemEvalProfileDefinition>
  >;
  readonly reader: LongMemEvalReaderDefinition;
  readonly aggregation: LongMemEvalAggregationDefinition;
  readonly scoreSpec: ScoreSpec;
}

export interface LongMemEvalReaderInput {
  readonly caseId: string;
  readonly question: string;
  readonly memoryContext: string;
  readonly signal?: AbortSignal;
}

export interface LongMemEvalReaderOutput {
  readonly answer: string;
  readonly durationMs: number;
  readonly tokens?: TokenUsage;
  readonly costUsd?: number;
}

export interface LongMemEvalReader {
  answer(
    input: LongMemEvalReaderInput,
  ): Promise<LongMemEvalReaderOutput>;
}

export interface LongMemEvalAnswerEvaluation {
  readonly answered: boolean;
  readonly abstained: boolean;
  readonly correct: boolean;
  readonly missingGroups: readonly (readonly string[])[];
  readonly matchedForbiddenTerms: readonly string[];
}

export interface LongMemEvalCaseMetrics {
  readonly qaAccuracy?: number;
  readonly recallAt5?: number;
  readonly precisionAt5?: number;
  readonly updateAccuracy?: number;
  readonly isolationAccuracy?: number;
  readonly expectedAbstention: boolean;
  readonly predictedAbstention?: boolean;
}

export interface LongMemEvalCaseEvidence extends JsonObject {
  readonly caseId: string;
  readonly capability: LongMemEvalCapability;
  readonly trial: number;
  readonly profile: LongMemEvalProfile;
  readonly query: string;
  readonly retrievedKeys: readonly string[];
  readonly memoryContext: string;
  readonly answer: string | null;
  readonly answerEvaluation: JsonObject | null;
  readonly operationChecksPassed: boolean;
  readonly stateChecksPassed: boolean;
  readonly memoryScopeLeakCount: number;
  readonly secretPersistedCount: number;
}

export interface LongMemEvalCaseResult {
  readonly caseId: string;
  readonly capability: LongMemEvalCapability;
  readonly trial: number;
  readonly profile: LongMemEvalProfile;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "invalid";
  readonly metrics: LongMemEvalCaseMetrics;
  readonly evidence: LongMemEvalCaseEvidence;
  readonly reader?: LongMemEvalReaderOutput;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface LongMemEvalComponentScores {
  readonly QAAccuracy: number;
  readonly RecallAt5: number;
  readonly PrecisionAt5: number;
  readonly UpdateAccuracy: number;
  readonly AbstentionF1: number;
  readonly IsolationAccuracy: number;
}

export interface LongMemEvalAggregation {
  readonly metrics: Readonly<Record<string, number>>;
  readonly componentScores: LongMemEvalComponentScores;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
}

export interface LongMemEvalRunReport {
  readonly runId: string;
  readonly manifestVersion: string;
  readonly profile: LongMemEvalProfile;
  readonly datasetSha256: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly componentScores: LongMemEvalComponentScores;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
}
