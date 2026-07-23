import {
  TERMINAL_BENCH_CONTRACT_VERSION,
  invalid,
  requireArray,
  requireIsoDate,
  requireNumber,
  requirePositiveInteger,
  requireRecord,
  requireString,
  optionalString,
  type HarborIdentity,
  type NormalizedTerminalBenchJob,
  type TerminalBenchBudgetManifest,
  type TerminalBenchManifest,
  type TerminalBenchTaskBudget,
} from "../contracts/index.js";

export function calibrateTerminalBenchBudget(
  manifest: TerminalBenchManifest,
  jobs: readonly NormalizedTerminalBenchJob[],
  clock: () => Date = () => new Date(),
): TerminalBenchBudgetManifest {
  if (jobs.length !== manifest.baseline.requiredRuns) {
    invalid("baseline calibration requires the frozen run count", {
      actual: jobs.length,
      expected: manifest.baseline.requiredRuns,
    });
  }
  if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length) {
    invalid("baseline calibration contains duplicate Harbor jobs");
  }

  const firstJob = jobs[0];
  if (firstJob === undefined || firstJob.trials.length === 0) {
    invalid("baseline calibration job must contain trials");
  }
  const baselineIdentity = firstJob.trials[0]?.identity;
  if (baselineIdentity === undefined) {
    invalid("baseline identity is missing");
  }

  for (const job of jobs) {
    assertEligibleBaselineJob(
      manifest,
      job,
      firstJob.datasetHash,
      baselineIdentity,
    );
  }

  const taskBudgets = buildTaskBudgets(manifest, jobs);
  return Object.freeze({
    contractVersion: TERMINAL_BENCH_CONTRACT_VERSION,
    id: `${manifest.id}-pi-baseline-v1`,
    datasetId: manifest.dataset.id,
    datasetHash: firstJob.datasetHash,
    estimator: "median",
    generatedAt: clock().toISOString(),
    sourceJobIds: Object.freeze(
      jobs.map((job) => job.jobId),
    ),
    baselineIdentity: Object.freeze({ ...baselineIdentity }),
    taskBudgets: Object.freeze(taskBudgets),
  });
}

export function parseTerminalBenchBudgetManifest(
  value: unknown,
  manifest: TerminalBenchManifest,
): TerminalBenchBudgetManifest {
  const source = requireRecord(value, "budget");
  if (
    source.contractVersion !== TERMINAL_BENCH_CONTRACT_VERSION
  ) {
    invalid("unsupported Terminal-Bench budget contract version");
  }
  const datasetId = requireString(
    source.datasetId,
    "budget.datasetId",
  );
  if (datasetId !== manifest.dataset.id) {
    invalid("budget dataset does not match Terminal-Bench manifest");
  }
  const datasetHash = requireString(
    source.datasetHash,
    "budget.datasetHash",
  );
  if (!/^[a-f0-9]{64}$/u.test(datasetHash)) {
    invalid("budget.datasetHash must be a SHA-256 digest");
  }
  const estimator = requireString(
    source.estimator,
    "budget.estimator",
  );
  if (estimator !== "median") {
    invalid("budget estimator must be median");
  }
  const sourceJobIds = requireArray(
    source.sourceJobIds,
    "budget.sourceJobIds",
  ).map((jobId, index) =>
    requireString(jobId, `budget.sourceJobIds[${index}]`)
  );
  if (
    sourceJobIds.length !== manifest.baseline.requiredRuns ||
    new Set(sourceJobIds).size !== sourceJobIds.length
  ) {
    invalid("budget must reference the frozen number of unique jobs");
  }
  const identity = parseBudgetIdentity(source.baselineIdentity);
  if (
    identity.agentName !== manifest.agents.baseline ||
    identity.agentVersion !== manifest.agents.piVersion
  ) {
    invalid("budget baseline agent does not match the manifest");
  }
  const taskBudgets = requireArray(
    source.taskBudgets,
    "budget.taskBudgets",
  ).map(parseTaskBudget);
  if (
    taskBudgets.length !== manifest.dataset.expectedTaskCount ||
    new Set(taskBudgets.map((budget) => budget.taskId)).size !==
      taskBudgets.length
  ) {
    invalid("budget must contain every task exactly once");
  }
  if (
    taskBudgets.some(
      (budget) =>
        budget.costSampleCount <
          manifest.baseline.minimumSamplesPerTask ||
        budget.durationSampleCount <
          manifest.baseline.minimumSamplesPerTask,
    )
  ) {
    invalid("budget task does not have enough baseline samples");
  }

  return Object.freeze({
    contractVersion: TERMINAL_BENCH_CONTRACT_VERSION,
    id: requireString(source.id, "budget.id"),
    datasetId,
    datasetHash,
    estimator,
    generatedAt: requireIsoDate(
      source.generatedAt,
      "budget.generatedAt",
    ),
    sourceJobIds: Object.freeze(sourceJobIds),
    baselineIdentity: Object.freeze(identity),
    taskBudgets: Object.freeze(taskBudgets),
  });
}

function assertEligibleBaselineJob(
  manifest: TerminalBenchManifest,
  job: NormalizedTerminalBenchJob,
  datasetHash: string,
  identity: HarborIdentity,
): void {
  if (
    job.datasetId !== manifest.dataset.id ||
    job.datasetHash !== datasetHash ||
    job.trials.length !== job.nTotalTrials
  ) {
    invalid("baseline jobs must use one complete resolved dataset", {
      jobId: job.jobId,
    });
  }
  const taskIds = new Set(job.trials.map((trial) => trial.taskId));
  if (taskIds.size !== manifest.dataset.expectedTaskCount) {
    invalid("baseline job does not cover the full task set", {
      jobId: job.jobId,
      taskCount: taskIds.size,
    });
  }
  const trialCounts = new Map<string, number>();
  for (const trial of job.trials) {
    trialCounts.set(
      trial.taskId,
      (trialCounts.get(trial.taskId) ?? 0) + 1,
    );
    if (
      trial.identity.agentName !== manifest.agents.baseline ||
      trial.identity.agentVersion !== manifest.agents.piVersion ||
      identityKey(trial.identity) !== identityKey(identity)
    ) {
      invalid("baseline jobs must use one frozen agent and model", {
        jobId: job.jobId,
      });
    }
  }
  if (
    [...trialCounts.values()].some(
      (count) => count < manifest.dataset.minimumTrialsPerTask,
    )
  ) {
    invalid("baseline job has too few trials for a task", {
      jobId: job.jobId,
    });
  }
  const validTrials = job.trials.filter(
    (trial) =>
      trial.status !== "invalid" &&
      trial.status !== "cancelled",
  );
  if (
    validTrials.length === 0 ||
    validTrials.length / job.trials.length < 0.98 ||
    validTrials.filter(
      (trial) =>
        trial.costUsd !== undefined && trial.costUsd > 0,
    ).length /
        validTrials.length <
      0.98 ||
    validTrials.filter(
      (trial) => trial.agentDurationMs > 0,
    ).length /
        validTrials.length <
      0.98
  ) {
    invalid(
      "baseline job does not meet validity and efficiency coverage",
      { jobId: job.jobId },
    );
  }
}

function buildTaskBudgets(
  manifest: TerminalBenchManifest,
  jobs: readonly NormalizedTerminalBenchJob[],
): TerminalBenchTaskBudget[] {
  const samples = new Map<
    string,
    {
      checksum: string;
      costs: number[];
      durations: number[];
    }
  >();
  for (const trial of jobs.flatMap((job) => job.trials)) {
    if (trial.status === "invalid" || trial.status === "cancelled") {
      continue;
    }
    const sample = samples.get(trial.taskId) ?? {
      checksum: trial.taskChecksum,
      costs: [],
      durations: [],
    };
    if (sample.checksum !== trial.taskChecksum) {
      invalid("task checksum changed during baseline calibration", {
        taskId: trial.taskId,
      });
    }
    if (trial.costUsd !== undefined && trial.costUsd > 0) {
      sample.costs.push(trial.costUsd);
    }
    if (trial.agentDurationMs > 0) {
      sample.durations.push(trial.agentDurationMs);
    }
    samples.set(trial.taskId, sample);
  }

  if (samples.size !== manifest.dataset.expectedTaskCount) {
    invalid("baseline samples do not cover the full task set");
  }

  return [...samples].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([taskId, sample]) => {
    if (
      sample.costs.length <
        manifest.baseline.minimumSamplesPerTask ||
      sample.durations.length <
        manifest.baseline.minimumSamplesPerTask
    ) {
      invalid("baseline task has insufficient efficiency samples", {
        taskId,
        costSamples: sample.costs.length,
        durationSamples: sample.durations.length,
      });
    }
    return Object.freeze({
      taskId,
      taskChecksum: sample.checksum,
      costUsd: median(sample.costs),
      agentDurationMs: median(sample.durations),
      costSampleCount: sample.costs.length,
      durationSampleCount: sample.durations.length,
    });
  });
}

function parseBudgetIdentity(value: unknown): HarborIdentity {
  const source = requireRecord(value, "budget.baselineIdentity");
  const thinkingLevel = optionalString(
    source.thinkingLevel,
    "budget.baselineIdentity.thinkingLevel",
  );
  return {
    agentName: requireString(
      source.agentName,
      "budget.baselineIdentity.agentName",
    ),
    agentVersion: requireString(
      source.agentVersion,
      "budget.baselineIdentity.agentVersion",
    ),
    modelProvider: requireString(
      source.modelProvider,
      "budget.baselineIdentity.modelProvider",
    ),
    modelName: requireString(
      source.modelName,
      "budget.baselineIdentity.modelName",
    ),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function parseTaskBudget(
  value: unknown,
  index: number,
): TerminalBenchTaskBudget {
  const field = `budget.taskBudgets[${index}]`;
  const source = requireRecord(value, field);
  const costUsd = requireNumber(
    source.costUsd,
    `${field}.costUsd`,
  );
  const agentDurationMs = requireNumber(
    source.agentDurationMs,
    `${field}.agentDurationMs`,
  );
  if (costUsd <= 0 || agentDurationMs <= 0) {
    invalid("task efficiency budgets must be positive", { field });
  }
  return Object.freeze({
    taskId: requireString(source.taskId, `${field}.taskId`),
    taskChecksum: requireString(
      source.taskChecksum,
      `${field}.taskChecksum`,
    ),
    costUsd,
    agentDurationMs,
    costSampleCount: requirePositiveInteger(
      source.costSampleCount,
      `${field}.costSampleCount`,
    ),
    durationSampleCount: requirePositiveInteger(
      source.durationSampleCount,
      `${field}.durationSampleCount`,
    ),
  });
}

function identityKey(identity: HarborIdentity): string {
  return [
    identity.agentName,
    identity.agentVersion,
    identity.modelProvider,
    identity.modelName,
    identity.thinkingLevel ?? "",
  ].join("\u0000");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    invalid("cannot calculate a median without samples");
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    invalid("cannot calculate an even median without two samples");
  }
  return (lower + upper) / 2;
}
