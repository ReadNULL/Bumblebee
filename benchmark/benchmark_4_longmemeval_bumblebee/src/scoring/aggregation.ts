import {
  calculateCompositeScore,
  evaluateHardGates,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  LONGMEMEVAL_CAPABILITIES,
  type LongMemEvalAggregation,
  type LongMemEvalCaseResult,
  type LongMemEvalComponentScores,
  type LongMemEvalDataset,
  type LongMemEvalManifest,
  type LongMemEvalProfile,
} from "../contracts/index.js";

export interface AggregateLongMemEvalOptions {
  readonly manifest: LongMemEvalManifest;
  readonly dataset: LongMemEvalDataset;
  readonly datasetSha256: string;
  readonly profile: LongMemEvalProfile;
  readonly results: readonly LongMemEvalCaseResult[];
  readonly observedPiVersion: string;
  readonly bumblebeeCommit: string;
  readonly workspaceClean: boolean;
}

export function aggregateLongMemEval(
  options: AggregateLongMemEvalOptions,
): LongMemEvalAggregation {
  const expectedTrials =
    options.dataset.cases.length *
    options.manifest.profiles[options.profile].repetitions;
  const completed = options.results.filter(
    (result) => result.status === "completed",
  );
  const caseById = new Map(
    options.dataset.cases.map((item) => [item.id, item]),
  );

  const qaAccuracy = macroAverage(
    options.results,
    () => true,
    (result) => result.metrics.qaAccuracy ?? 0,
  );
  const recallAt5 = macroAverage(
    options.results,
    (result) =>
      (caseById.get(result.caseId)?.query.relevantKeys.length ?? 0) >
      0,
    (result) => result.metrics.recallAt5 ?? 0,
  );
  const precisionAt5 = macroAverage(
    options.results,
    (result) =>
      (caseById.get(result.caseId)?.query.relevantKeys.length ?? 0) >
      0,
    (result) => result.metrics.precisionAt5 ?? 0,
  );
  const updateAccuracy = macroAverage(
    options.results,
    (result) =>
      caseById.get(result.caseId)?.checks?.update !== undefined,
    (result) => result.metrics.updateAccuracy ?? 0,
  );
  const isolationAccuracy = macroAverage(
    options.results,
    (result) =>
      caseById.get(result.caseId)?.checks?.isolation !== undefined,
    (result) => result.metrics.isolationAccuracy ?? 0,
  );
  const abstentionF1 = calculateAbstentionF1(options.results);

  const componentScores: LongMemEvalComponentScores = Object.freeze({
    QAAccuracy: toScore(qaAccuracy),
    RecallAt5: toScore(recallAt5),
    PrecisionAt5: toScore(precisionAt5),
    UpdateAccuracy: toScore(updateAccuracy),
    AbstentionF1: toScore(abstentionF1),
    IsolationAccuracy: toScore(isolationAccuracy),
  });
  const coveredCapabilities = new Set(
    options.dataset.cases.map((item) => item.capability),
  );
  const formal =
    options.manifest.profiles[options.profile].formal &&
    options.profile === "bumblebee-full";
  const metrics = Object.freeze({
    dataset_identity_match:
      options.dataset.id === options.manifest.id &&
        options.dataset.version === options.manifest.version
        ? 1
        : 0,
    dataset_hash_match:
      options.datasetSha256 === options.manifest.dataset.sha256
        ? 1
        : 0,
    dataset_case_count: options.dataset.cases.length,
    capability_coverage_rate: divide(
      options.manifest.dataset.capabilities.filter(
        (capability) => coveredCapabilities.has(capability),
      ).length,
      options.manifest.dataset.capabilities.length,
    ),
    pi_version_match:
      options.observedPiVersion ===
        options.manifest.reader.piVersion
        ? 1
        : 0,
    adapter_error_count:
      options.results.length !== expectedTrials
        ? Math.max(
            1,
            expectedTrials - options.results.length,
          )
        : options.results.length - completed.length,
    valid_task_rate: divide(completed.length, expectedTrials),
    formal_profile_match: formal ? 1 : 0,
    answer_coverage_rate: divide(
      options.results.filter(
        (result) => result.metrics.qaAccuracy !== undefined,
      ).length,
      expectedTrials,
    ),
    candidate_commit_pinned:
      formal &&
        /^[a-f0-9]{40,64}$/u.test(options.bumblebeeCommit)
        ? 1
        : 0,
    workspace_clean: options.workspaceClean ? 1 : 0,
    memory_scope_leak_count: sum(
      options.results.map(
        (result) => result.evidence.memoryScopeLeakCount,
      ),
    ),
    secret_persisted_count: sum(
      options.results.map(
        (result) => result.evidence.secretPersistedCount,
      ),
    ),
    qa_accuracy: qaAccuracy,
    recall_at_5: recallAt5,
    precision_at_5: precisionAt5,
    update_accuracy: updateAccuracy,
    abstention_f1: abstentionF1,
    isolation_accuracy: isolationAccuracy,
    total_input_tokens: sum(
      options.results.map(
        (result) => result.reader?.tokens?.input ?? 0,
      ),
    ),
    total_output_tokens: sum(
      options.results.map(
        (result) => result.reader?.tokens?.output ?? 0,
      ),
    ),
    total_cost_usd: round(sum(
      options.results.map(
        (result) => result.reader?.costUsd ?? 0,
      ),
    )),
    total_duration_ms: sum(
      options.results.map((result) => result.durationMs),
    ),
  });
  const gateEvaluation = evaluateHardGates(
    options.manifest.scoreSpec,
    metrics,
  );
  const score = calculateCompositeScore(
    options.manifest.scoreSpec,
    { ...componentScores },
    gateEvaluation,
  );

  return Object.freeze({
    metrics,
    componentScores,
    gateEvaluation,
    score,
  });
}

function macroAverage(
  results: readonly LongMemEvalCaseResult[],
  applicable: (result: LongMemEvalCaseResult) => boolean,
  select: (result: LongMemEvalCaseResult) => number,
): number {
  const capabilityMeans: number[] = [];
  for (const capability of LONGMEMEVAL_CAPABILITIES) {
    const values = results
      .filter(
        (result) =>
          result.capability === capability && applicable(result),
      )
      .map(select);
    if (values.length > 0) {
      capabilityMeans.push(mean(values));
    }
  }
  return mean(capabilityMeans);
}

function calculateAbstentionF1(
  results: readonly LongMemEvalCaseResult[],
): number {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const result of results) {
    const predicted = result.metrics.predictedAbstention ?? false;
    const expected = result.metrics.expectedAbstention;
    if (predicted && expected) {
      truePositive += 1;
    } else if (predicted) {
      falsePositive += 1;
    } else if (expected) {
      falseNegative += 1;
    }
  }
  const precision = divide(
    truePositive,
    truePositive + falsePositive,
  );
  const recall = divide(
    truePositive,
    truePositive + falseNegative,
  );
  return divide(2 * precision * recall, precision + recall);
}

function mean(values: readonly number[]): number {
  return divide(sum(values), values.length);
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toScore(value: number): number {
  return round(Math.min(1, Math.max(0, value)) * 100);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
