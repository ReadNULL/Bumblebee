import {
  calculateCompositeScore,
  evaluateHardGates,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  compareTerminalBenchTaskSelection,
  type NormalizedTerminalBenchJob,
  type NormalizedTerminalBenchTrial,
  type TerminalBenchAggregation,
  type TerminalBenchBudgetManifest,
  type TerminalBenchManifest,
  type TerminalBenchTaskBudget,
} from "../contracts/index.js";

export function aggregateTerminalBench(
  manifest: TerminalBenchManifest,
  job: NormalizedTerminalBenchJob,
  budget?: TerminalBenchBudgetManifest,
): TerminalBenchAggregation {
  const taskIds = new Set(job.trials.map((trial) => trial.taskId));
  const taskSelection = compareTerminalBenchTaskSelection(
    manifest,
    taskIds,
  );
  const validTrials = job.trials.filter(isValidTrial);
  const scoredTrials = validTrials.filter(
    (
      trial,
    ): trial is NormalizedTerminalBenchTrial & {
      readonly reward: number;
    } => trial.reward !== undefined,
  );
  const taskBudgets = createBudgetMap(job, budget);
  const efficiencyBudgetCoverage = calculateBudgetCoverage(
    job,
    taskBudgets,
  );
  const agentIdentities = new Set(
    job.trials.map((trial) =>
      [
        trial.identity.agentName,
        trial.identity.agentVersion,
      ].join("\u0000")
    ),
  );
  const modelIdentities = new Set(
    job.trials.map((trial) =>
      [
        trial.identity.modelProvider,
        trial.identity.modelName,
        trial.identity.thinkingLevel ?? "",
      ].join("\u0000")
    ),
  );
  const extensionSources = new Set(
    job.trials.flatMap((trial) =>
      trial.extensionSource === undefined
        ? []
        : [trial.extensionSource]
    ),
  );

  const metrics = Object.freeze({
    dataset_identity_match:
      job.datasetId === manifest.dataset.id &&
        job.trials.every(
          (trial) => trial.datasetId === manifest.dataset.id,
        )
        ? 1
        : 0,
    task_coverage_rate: divide(
      taskSelection.matchedCount,
      manifest.dataset.expectedTaskCount,
    ),
    task_selection_match: taskSelection.exact ? 1 : 0,
    unexpected_task_count:
      taskSelection.unexpectedTaskIds.length,
    job_completion_rate: divide(
      job.trials.length,
      job.nTotalTrials,
    ),
    minimum_trials_per_task: minimumTrialsPerTask(job),
    task_checksum_conflict_count:
      countTaskChecksumConflicts(job),
    candidate_agent_match:
      job.trials.length > 0 &&
        job.trials.every(
          (trial) =>
            trial.identity.agentName ===
            manifest.agents.candidate,
        )
        ? 1
        : 0,
    agent_identity_conflict_count: Math.max(
      0,
      agentIdentities.size - 1,
    ),
    model_identity_conflict_count: Math.max(
      0,
      modelIdentities.size - 1,
    ),
    pi_version_match:
      job.trials.length > 0 &&
        job.trials.every(
          (trial) =>
            trial.identity.agentVersion ===
            manifest.agents.piVersion,
        )
        ? 1
        : 0,
    extension_source_pinned:
      job.trials.length > 0 &&
        extensionSources.size === 1 &&
        job.trials.every(
          (trial) =>
            trial.extensionCommit !== undefined &&
            trial.extensionSource?.startsWith(
              manifest.agents.extensionSourcePrefix,
            ) === true,
        )
        ? 1
        : 0,
    valid_trial_rate: divide(
      validTrials.length,
      job.trials.length,
    ),
    reward_coverage_rate: divide(
      scoredTrials.length,
      job.trials.length,
    ),
    baseline_dataset_identity_match:
      budget === undefined ||
        (
          budget.datasetId === job.datasetId &&
          budget.datasetHash === job.datasetHash
        )
        ? 1
        : 0,
    baseline_agent_identity_match:
      budget === undefined ||
        (
          budget.baselineIdentity.agentName ===
            manifest.agents.baseline &&
          budget.baselineIdentity.agentVersion ===
            manifest.agents.piVersion
        )
        ? 1
        : 0,
    baseline_model_identity_match:
      budget === undefined ||
        job.trials.every(
          (trial) =>
            trial.identity.modelProvider ===
              budget.baselineIdentity.modelProvider &&
            trial.identity.modelName ===
              budget.baselineIdentity.modelName &&
            trial.identity.thinkingLevel ===
              budget.baselineIdentity.thinkingLevel,
        )
        ? 1
        : 0,
    cost_coverage_rate: divide(
      validTrials.filter(
        (trial) =>
          trial.costUsd !== undefined && trial.costUsd > 0,
      ).length,
      validTrials.length,
    ),
    latency_coverage_rate: divide(
      validTrials.filter(
        (trial) => trial.agentDurationMs > 0,
      ).length,
      validTrials.length,
    ),
    efficiency_budget_coverage: efficiencyBudgetCoverage,
    stable_trial_rate: divide(
      job.trials.filter((trial) => trial.stable).length,
      job.trials.length,
    ),
    official_reward_mean: mean(
      scoredTrials.map((trial) => trial.reward),
    ),
    total_cost_usd: sum(
      job.trials.map((trial) => trial.costUsd ?? 0),
    ),
    total_agent_duration_ms: sum(
      job.trials.map((trial) => trial.agentDurationMs),
    ),
  });
  const componentScores = Object.freeze({
    OfficialReward: round(metrics.official_reward_mean * 100),
    CostEfficiency: round(
      mean(
        scoredTrials.map((trial) =>
          scoreCostEfficiency(
            trial,
            taskBudgets.get(trial.taskId),
          )
        ),
      ) * 100,
    ),
    LatencyEfficiency: round(
      mean(
        scoredTrials.map((trial) =>
          scoreLatencyEfficiency(
            trial,
            taskBudgets.get(trial.taskId),
          )
        ),
      ) * 100,
    ),
    Stability: round(metrics.stable_trial_rate * 100),
  });
  const gateEvaluation = evaluateHardGates(
    manifest.scoreSpec,
    metrics,
  );
  const score = calculateCompositeScore(
    manifest.scoreSpec,
    componentScores,
    gateEvaluation,
  );

  return Object.freeze({
    metrics,
    componentScores,
    gateEvaluation,
    score,
  });
}

function createBudgetMap(
  job: NormalizedTerminalBenchJob,
  budget: TerminalBenchBudgetManifest | undefined,
): ReadonlyMap<string, TerminalBenchTaskBudget> {
  if (
    budget === undefined ||
    budget.datasetId !== job.datasetId ||
    budget.datasetHash !== job.datasetHash
  ) {
    return new Map();
  }
  return new Map(
    budget.taskBudgets.map((taskBudget) => [
      taskBudget.taskId,
      taskBudget,
    ]),
  );
}

function calculateBudgetCoverage(
  job: NormalizedTerminalBenchJob,
  budgets: ReadonlyMap<string, TerminalBenchTaskBudget>,
): number {
  const checksums = new Map<string, string>();
  for (const trial of job.trials) {
    if (!checksums.has(trial.taskId)) {
      checksums.set(trial.taskId, trial.taskChecksum);
    }
  }
  const covered = [...checksums].filter(
    ([taskId, checksum]) =>
      budgets.get(taskId)?.taskChecksum === checksum,
  ).length;
  return divide(covered, checksums.size);
}

function scoreCostEfficiency(
  trial: NormalizedTerminalBenchTrial & { readonly reward: number },
  budget: TerminalBenchTaskBudget | undefined,
): number {
  if (
    trial.reward <= 0 ||
    budget === undefined ||
    trial.costUsd === undefined ||
    trial.costUsd <= 0
  ) {
    return 0;
  }
  return Math.min(1, budget.costUsd / trial.costUsd);
}

function scoreLatencyEfficiency(
  trial: NormalizedTerminalBenchTrial & { readonly reward: number },
  budget: TerminalBenchTaskBudget | undefined,
): number {
  if (
    trial.reward <= 0 ||
    budget === undefined ||
    trial.agentDurationMs <= 0
  ) {
    return 0;
  }
  return Math.min(
    1,
    budget.agentDurationMs / trial.agentDurationMs,
  );
}

function isValidTrial(
  trial: NormalizedTerminalBenchTrial,
): boolean {
  return trial.status !== "invalid" &&
    trial.status !== "cancelled";
}

function minimumTrialsPerTask(
  job: NormalizedTerminalBenchJob,
): number {
  const counts = new Map<string, number>();
  for (const trial of job.trials) {
    counts.set(
      trial.taskId,
      (counts.get(trial.taskId) ?? 0) + 1,
    );
  }
  return counts.size === 0
    ? 0
    : Math.min(...counts.values());
}

function countTaskChecksumConflicts(
  job: NormalizedTerminalBenchJob,
): number {
  const checksums = new Map<string, Set<string>>();
  for (const trial of job.trials) {
    const taskChecksums =
      checksums.get(trial.taskId) ?? new Set<string>();
    taskChecksums.add(trial.taskChecksum);
    checksums.set(trial.taskId, taskChecksums);
  }
  return [...checksums.values()].filter(
    (values) => values.size > 1,
  ).length;
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
