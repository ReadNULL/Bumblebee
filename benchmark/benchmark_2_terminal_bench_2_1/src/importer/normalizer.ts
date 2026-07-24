import { createHash } from "node:crypto";

import type {
  EvaluationFailure,
  FailureCategory,
  TaskStatus,
  TokenUsage,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  TERMINAL_BENCH_CONTRACT_VERSION,
  invalid,
  optionalNumber,
  optionalString,
  requireArray,
  requireIsoDate,
  requirePositiveInteger,
  requireRecord,
  requireString,
  type HarborIdentity,
  type HarborJobProvenance,
  type NormalizedTerminalBenchJob,
  type NormalizedTerminalBenchTrial,
  type TerminalBenchManifest,
} from "../contracts/index.js";

interface DraftTrial
  extends Omit<NormalizedTerminalBenchTrial, "trial"> {}

interface ParsedJobConfig {
  readonly concurrency: number;
  readonly datasetId: string;
  readonly datasetReference: string;
  readonly environmentType: string;
}

export interface HarborJobNormalizationOptions {
  readonly allowModelLessTrials?: boolean;
}

const INFRASTRUCTURE_EXCEPTIONS = [
  "ApiConnectionClosedError",
  "ApiInternalServerError",
  "ApiOverloadedError",
  "ApiRateLimitError",
  "ApiResponseStalledError",
  "ApiUsageLimitError",
  "AgentAuthenticationError",
  "Docker",
  "Environment",
  "ModelNotFoundError",
  "NetworkConnectionError",
] as const;

const DATASET_EXCEPTIONS = [
  "BenchmarkEvidenceLeakError",
  "RewardFile",
  "Verifier",
] as const;

const ADAPTER_EXCEPTIONS = [
  "AgentImport",
  "Protocol",
  "TrajectoryParse",
] as const;

const VERIFIER_INFRASTRUCTURE_EXCEPTIONS = [
  "VerifierInfrastructureError",
] as const;

export function normalizeHarborJob(
  configValue: unknown,
  resultValue: unknown,
  provenance: HarborJobProvenance,
  manifest: TerminalBenchManifest,
  options: HarborJobNormalizationOptions = {},
): NormalizedTerminalBenchJob {
  const config = parseJobConfig(configValue, manifest);
  const result = requireRecord(resultValue, "Harbor result");
  const jobId = requireString(result.id, "Harbor result.id");
  const startedAt = requireIsoDate(
    result.started_at,
    "Harbor result.started_at",
  );
  const finishedAt = readJobFinishedAt(result, startedAt);
  const nTotalTrials = requirePositiveInteger(
    result.n_total_trials,
    "Harbor result.n_total_trials",
  );
  const rawTrials = requireArray(
    result.trial_results,
    "Harbor result.trial_results",
  );
  const drafts = rawTrials.map((trial, index) =>
    normalizeTrial(
      trial,
      index,
      jobId,
      config,
      manifest,
      options,
    ),
  );
  const trials = assignTrialNumbers(drafts);

  return Object.freeze({
    contractVersion: TERMINAL_BENCH_CONTRACT_VERSION,
    jobId,
    startedAt,
    finishedAt,
    nTotalTrials,
    concurrency: config.concurrency,
    environmentType: config.environmentType,
    datasetId: config.datasetId,
    datasetReference: config.datasetReference,
    datasetHash: createDatasetHash(trials),
    trials: Object.freeze(trials),
    provenance: Object.freeze({ ...provenance }),
  });
}

function readJobFinishedAt(
  result: Readonly<Record<string, unknown>>,
  startedAt: string,
): string {
  const value = result.finished_at ?? result.updated_at;
  if (value === undefined || value === null) {
    return startedAt;
  }
  const finishedAt = requireIsoDate(
    value,
    result.finished_at === undefined ||
        result.finished_at === null
      ? "Harbor result.updated_at"
      : "Harbor result.finished_at",
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    invalid("Harbor job finished before it started");
  }
  return finishedAt;
}

export function extractPinnedGitCommit(
  extensionSource: string,
): string | undefined {
  if (!extensionSource.startsWith("git:")) {
    return undefined;
  }
  const separator = extensionSource.lastIndexOf("@");
  if (separator <= "git:".length) {
    return undefined;
  }
  const reference = extensionSource.slice(separator + 1);
  return /^[a-f0-9]{40}$/iu.test(reference)
    ? reference.toLowerCase()
    : undefined;
}

function parseJobConfig(
  value: unknown,
  manifest: TerminalBenchManifest,
): ParsedJobConfig {
  const source = requireRecord(value, "Harbor config");
  const datasets = requireArray(
    source.datasets,
    "Harbor config.datasets",
  );
  if (datasets.length !== 1) {
    invalid("Harbor job must contain exactly one dataset", {
      datasetCount: datasets.length,
    });
  }
  const dataset = requireRecord(
    datasets[0],
    "Harbor config.datasets[0]",
  );
  const datasetId = requireString(
    dataset.name,
    "Harbor config.datasets[0].name",
  );
  const datasetReference =
    optionalString(
      dataset.ref,
      "Harbor config.datasets[0].ref",
    ) ??
    optionalString(
      dataset.version,
      "Harbor config.datasets[0].version",
    ) ??
    manifest.dataset.reference;
  const environment = source.environment === undefined
    ? {}
    : requireRecord(
        source.environment,
        "Harbor config.environment",
      );

  return {
    concurrency:
      source.n_concurrent_trials === undefined
        ? 4
        : requirePositiveInteger(
            source.n_concurrent_trials,
            "Harbor config.n_concurrent_trials",
          ),
    datasetId,
    datasetReference,
    environmentType:
      optionalString(
        environment.type,
        "Harbor config.environment.type",
      ) ?? "docker",
  };
}

function normalizeTrial(
  value: unknown,
  index: number,
  jobId: string,
  jobConfig: ParsedJobConfig,
  manifest: TerminalBenchManifest,
  options: HarborJobNormalizationOptions,
): DraftTrial {
  const field = `Harbor result.trial_results[${index}]`;
  const source = requireRecord(value, field);
  const taskId = requireString(source.task_name, `${field}.task_name`);
  const startedAt = requireIsoDate(
    source.started_at,
    `${field}.started_at`,
  );
  const finishedAt = requireIsoDate(
    source.finished_at,
    `${field}.finished_at`,
  );
  const durationMs = elapsedMs(startedAt, finishedAt, field);
  const trialConfig = requireRecord(source.config, `${field}.config`);
  const agentConfig = requireRecord(
    trialConfig.agent,
    `${field}.config.agent`,
  );
  const thinkingLevel = readAgentKwarg(
    agentConfig,
    "thinking",
    field,
  );
  const identity = parseIdentity(
    source.agent_info,
    thinkingLevel,
    field,
    options.allowModelLessTrials === true,
  );
  const extensionSource = readExtensionSource(agentConfig, field);
  const extensionCommit = extensionSource === undefined
    ? undefined
    : extractPinnedGitCommit(extensionSource);
  const reward = readReward(
    source.verifier_result,
    manifest.rewardKey,
    field,
  );
  const exceptionTypes = readExceptionTypes(source);
  const stable =
    exceptionTypes.length === 0 && reward !== undefined;
  const failureCategory = classifyException(
    exceptionTypes,
    source,
  );
  const status = determineStatus(
    reward,
    exceptionTypes,
    failureCategory,
  );
  const failure = createFailure(
    status,
    reward,
    exceptionTypes,
    failureCategory,
  );
  const usage = readUsage(source, field);

  return {
    jobId,
    harborTrialId: requireString(source.id, `${field}.id`),
    taskId,
    taskChecksum: requireString(
      source.task_checksum,
      `${field}.task_checksum`,
    ),
    trialName: requireString(
      source.trial_name,
      `${field}.trial_name`,
    ),
    datasetId:
      optionalString(source.source, `${field}.source`) ??
      jobConfig.datasetId,
    datasetReference: jobConfig.datasetReference,
    identity,
    ...(extensionSource === undefined
      ? {}
      : {
          extensionSource,
          ...(extensionCommit === undefined
            ? {}
            : { extensionCommit }),
        }),
    status,
    startedAt,
    finishedAt,
    durationMs,
    agentDurationMs: readAgentDuration(source, durationMs, field),
    ...(reward === undefined ? {} : { reward }),
    ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
    ...(usage.costUsd === undefined
      ? {}
      : { costUsd: usage.costUsd }),
    stable,
    ...(failure === undefined ? {} : { failure }),
  };
}

function parseIdentity(
  value: unknown,
  thinkingLevel: string | undefined,
  field: string,
  allowModelLess: boolean,
): HarborIdentity {
  const source = requireRecord(value, `${field}.agent_info`);
  const agentName = requireString(
    source.name,
    `${field}.agent_info.name`,
  );
  const agentVersion = requireString(
    source.version,
    `${field}.agent_info.version`,
  );
  if (
    allowModelLess &&
    (
      source.model_info === undefined ||
      source.model_info === null
    )
  ) {
    return Object.freeze({
      agentName,
      agentVersion,
      modelProvider: "none",
      modelName: "none",
      ...(thinkingLevel === undefined
        ? {}
        : { thinkingLevel }),
    });
  }
  const model = requireRecord(
    source.model_info,
    `${field}.agent_info.model_info`,
  );
  const rawModelName = requireString(
    model.name,
    `${field}.agent_info.model_info.name`,
  );
  const configuredProvider = optionalString(
    model.provider,
    `${field}.agent_info.model_info.provider`,
  );
  const separator = rawModelName.indexOf("/");
  const inferredProvider = separator > 0
    ? rawModelName.slice(0, separator)
    : undefined;
  const modelName =
    configuredProvider !== undefined &&
      rawModelName.startsWith(`${configuredProvider}/`)
      ? rawModelName.slice(configuredProvider.length + 1)
      : separator > 0
        ? rawModelName.slice(separator + 1)
        : rawModelName;

  return Object.freeze({
    agentName,
    agentVersion,
    modelProvider:
      configuredProvider ?? inferredProvider ?? "unknown",
    modelName,
    ...(thinkingLevel === undefined
      ? {}
      : { thinkingLevel }),
  });
}

function readExtensionSource(
  agentConfig: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  return readAgentKwarg(
    agentConfig,
    "bumblebee_extension",
    field,
  );
}

function readAgentKwarg(
  agentConfig: Readonly<Record<string, unknown>>,
  name: string,
  field: string,
): string | undefined {
  const kwargsValue = agentConfig.kwargs;
  if (kwargsValue === undefined || kwargsValue === null) {
    return undefined;
  }
  const kwargs = requireRecord(
    kwargsValue,
    `${field}.config.agent.kwargs`,
  );
  return optionalString(
    kwargs[name],
    `${field}.config.agent.kwargs.${name}`,
  );
}

function readReward(
  value: unknown,
  rewardKey: string,
  field: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const verifier = requireRecord(value, `${field}.verifier_result`);
  if (verifier.rewards === undefined || verifier.rewards === null) {
    return undefined;
  }
  const rewards = requireRecord(
    verifier.rewards,
    `${field}.verifier_result.rewards`,
  );
  const reward = optionalNumber(
    rewards[rewardKey],
    `${field}.verifier_result.rewards.${rewardKey}`,
  );
  if (reward !== undefined && (reward < 0 || reward > 1)) {
    invalid("Terminal-Bench reward must be between 0 and 1", {
      field,
      reward,
    });
  }
  return reward;
}

function readExceptionTypes(
  trial: Readonly<Record<string, unknown>>,
): readonly string[] {
  const types: string[] = [];
  addExceptionType(types, trial.exception_info);
  if (Array.isArray(trial.step_results)) {
    for (const stepValue of trial.step_results) {
      if (
        typeof stepValue === "object" &&
        stepValue !== null &&
        !Array.isArray(stepValue)
      ) {
        addExceptionType(
          types,
          (stepValue as Readonly<Record<string, unknown>>)
            .exception_info,
        );
      }
    }
  }
  return Object.freeze([...new Set(types)]);
}

function addExceptionType(
  target: string[],
  value: unknown,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return;
  }
  const exceptionType = (
    value as Readonly<Record<string, unknown>>
  ).exception_type;
  if (
    typeof exceptionType === "string" &&
    exceptionType.trim().length > 0
  ) {
    target.push(exceptionType.trim());
  }
}

function classifyException(
  exceptionTypes: readonly string[],
  trial: Readonly<Record<string, unknown>>,
): FailureCategory {
  if (
    exceptionTypes.length > 0 &&
    (trial.agent_execution === undefined ||
      trial.agent_execution === null)
  ) {
    return trial.agent_setup === undefined ||
      trial.agent_setup === null
      ? "infrastructure"
      : "adapter";
  }
  if (
    matchesAny(
      exceptionTypes,
      VERIFIER_INFRASTRUCTURE_EXCEPTIONS,
    )
  ) {
    return "infrastructure";
  }
  if (matchesAny(exceptionTypes, DATASET_EXCEPTIONS)) {
    return "dataset";
  }
  if (matchesAny(exceptionTypes, ADAPTER_EXCEPTIONS)) {
    return "adapter";
  }
  if (matchesAny(exceptionTypes, INFRASTRUCTURE_EXCEPTIONS)) {
    return "infrastructure";
  }
  if (
    exceptionTypes.some((type) =>
      type.includes("ContextWindow") ||
      type.includes("OutputToken") ||
      type.includes("SafetyRefusal")
    )
  ) {
    return "model";
  }
  return "bumblebee";
}

function matchesAny(
  values: readonly string[],
  fragments: readonly string[],
): boolean {
  return values.some((value) =>
    fragments.some((fragment) => value.includes(fragment))
  );
}

function determineStatus(
  reward: number | undefined,
  exceptionTypes: readonly string[],
  failureCategory: FailureCategory,
): TaskStatus {
  if (
    exceptionTypes.some((type) => type.includes("Cancelled"))
  ) {
    return "cancelled";
  }
  if (
    exceptionTypes.length > 0 &&
    (
      failureCategory === "adapter" ||
      failureCategory === "dataset" ||
      failureCategory === "infrastructure"
    )
  ) {
    return "invalid";
  }
  if (reward === undefined) {
    return "invalid";
  }
  return reward > 0 ? "passed" : "failed";
}

function createFailure(
  status: TaskStatus,
  reward: number | undefined,
  exceptionTypes: readonly string[],
  category: FailureCategory,
): EvaluationFailure | undefined {
  if (status === "passed") {
    return undefined;
  }
  if (exceptionTypes.length > 0) {
    return {
      category,
      code: `HARBOR_${exceptionTypes[0] ?? "UNKNOWN"}`.toUpperCase(),
      message:
        `Harbor reported ${exceptionTypes.join(", ")} during the trial`,
      retryable:
        category === "adapter" ||
        category === "infrastructure",
    };
  }
  if (reward === undefined) {
    return {
      category: "dataset",
      code: "HARBOR_REWARD_MISSING",
      message: "Harbor verifier did not provide the configured reward",
      retryable: true,
    };
  }
  return {
    category: "model",
    code: "OFFICIAL_REWARD_ZERO",
    message: "The official verifier returned zero reward",
  };
}

function readUsage(
  trial: Readonly<Record<string, unknown>>,
  field: string,
): {
  readonly tokens?: TokenUsage;
  readonly costUsd?: number;
} {
  const contexts: Readonly<Record<string, unknown>>[] = [];
  if (trial.agent_result !== undefined && trial.agent_result !== null) {
    contexts.push(
      requireRecord(trial.agent_result, `${field}.agent_result`),
    );
  } else if (Array.isArray(trial.step_results)) {
    for (let index = 0; index < trial.step_results.length; index += 1) {
      const step = requireRecord(
        trial.step_results[index],
        `${field}.step_results[${index}]`,
      );
      if (step.agent_result !== undefined && step.agent_result !== null) {
        contexts.push(
          requireRecord(
            step.agent_result,
            `${field}.step_results[${index}].agent_result`,
          ),
        );
      }
    }
  }
  if (contexts.length === 0) {
    return {};
  }

  let input: number | undefined;
  let output: number | undefined;
  let cacheRead: number | undefined;
  let costUsd: number | undefined;
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    if (context === undefined) {
      continue;
    }
    input = addOptionalNonNegative(
      input,
      context.n_input_tokens,
      `${field}.agentContext[${index}].n_input_tokens`,
    );
    output = addOptionalNonNegative(
      output,
      context.n_output_tokens,
      `${field}.agentContext[${index}].n_output_tokens`,
    );
    cacheRead = addOptionalNonNegative(
      cacheRead,
      context.n_cache_tokens,
      `${field}.agentContext[${index}].n_cache_tokens`,
    );
    costUsd = addOptionalNonNegative(
      costUsd,
      context.cost_usd,
      `${field}.agentContext[${index}].cost_usd`,
    );
  }

  return {
    ...(input === undefined && output === undefined
      ? {}
      : {
          tokens: {
            input: input ?? 0,
            output: output ?? 0,
            ...(cacheRead === undefined
              ? {}
              : { cacheRead }),
          },
        }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function addOptionalNonNegative(
  total: number | undefined,
  value: unknown,
  field: string,
): number | undefined {
  const number = optionalNumber(value, field);
  if (number === undefined) {
    return total;
  }
  if (number < 0) {
    invalid(`${field} must not be negative`, { field, number });
  }
  return (total ?? 0) + number;
}

function readAgentDuration(
  trial: Readonly<Record<string, unknown>>,
  fallbackMs: number,
  field: string,
): number {
  const direct = readTiming(
    trial.agent_execution,
    `${field}.agent_execution`,
  );
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(trial.step_results)) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < trial.step_results.length; index += 1) {
      const step = requireRecord(
        trial.step_results[index],
        `${field}.step_results[${index}]`,
      );
      const duration = readTiming(
        step.agent_execution,
        `${field}.step_results[${index}].agent_execution`,
      );
      if (duration !== undefined) {
        total += duration;
        count += 1;
      }
    }
    if (count > 0) {
      return total;
    }
  }
  return fallbackMs;
}

function readTiming(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const timing = requireRecord(value, field);
  const startedAt = optionalString(
    timing.started_at,
    `${field}.started_at`,
  );
  const finishedAt = optionalString(
    timing.finished_at,
    `${field}.finished_at`,
  );
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }
  return elapsedMs(startedAt, finishedAt, field);
}

function elapsedMs(
  startedAt: string,
  finishedAt: string,
  field: string,
): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started
  ) {
    invalid(`${field} has an invalid time range`, { field });
  }
  return finished - started;
}

function assignTrialNumbers(
  drafts: readonly DraftTrial[],
): NormalizedTerminalBenchTrial[] {
  const byTask = new Map<string, DraftTrial[]>();
  for (const draft of drafts) {
    const values = byTask.get(draft.taskId) ?? [];
    values.push(draft);
    byTask.set(draft.taskId, values);
  }

  const trials: NormalizedTerminalBenchTrial[] = [];
  for (const values of byTask.values()) {
    values.sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.trialName.localeCompare(right.trialName)
    );
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value !== undefined) {
        trials.push(Object.freeze({
          ...value,
          trial: index + 1,
        }));
      }
    }
  }
  return trials.sort((left, right) =>
    left.taskId.localeCompare(right.taskId) ||
    left.trial - right.trial
  );
}

function createDatasetHash(
  trials: readonly NormalizedTerminalBenchTrial[],
): string {
  const identities = [
    ...new Set(
      trials.map((trial) =>
        `${trial.taskId}\u0000${trial.taskChecksum}`
      ),
    ),
  ].sort();
  return createHash("sha256")
    .update(identities.join("\n"), "utf8")
    .digest("hex");
}
