import {
  EVALUATION_CONTRACT_VERSION,
  assertGateEvaluation,
  assertIdentifier,
  assertIsoTimestamp,
  assertSha256,
  type CompositeScore,
  type EnvironmentIdentity,
  type EvaluationFailure,
  type EvaluationRunManifest,
  type EvaluationRunSummary,
  type EvaluationTaskCounts,
  type GateEvaluation,
  type ModelIdentity,
  type SubjectIdentity,
  type SuiteIdentity,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  invalid,
  requireArray,
  requireBoolean,
  requireFiniteNumber,
  requireInteger,
  requireMetricMap,
  requireOneOf,
  requireRecord,
  requireString,
} from "../contracts/index.js";
import { parseArtifactReference } from "./artifact-integrity.js";

const RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "invalid",
] as const;
const QUALIFICATION_STATUSES = [
  "qualified",
  "not-qualified",
  "invalid",
] as const;

export function parseRunManifest(
  value: unknown,
): EvaluationRunManifest {
  const source = requireRecord(value, "run manifest");
  if (source.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid("source run uses an unsupported manifest contract");
  }
  const runId = requireString(source.runId, "run manifest.runId");
  assertIdentifier(runId, "run manifest.runId");
  const suite = parseSuiteIdentity(source.suite);
  const subject = parseSubjectIdentity(source.subject);
  const environment = parseEnvironmentIdentity(source.environment);
  const model = source.model === undefined
    ? undefined
    : parseModelIdentity(source.model);
  const budgetSource = requireRecord(
    source.budget,
    "run manifest.budget",
  );
  const startedAt = requireString(
    source.startedAt,
    "run manifest.startedAt",
  );
  assertIsoTimestamp(startedAt, "run manifest.startedAt");

  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    runId,
    ...(source.parentRunId === undefined
      ? {}
      : {
          parentRunId: requireString(
            source.parentRunId,
            "run manifest.parentRunId",
          ),
        }),
    scoreSpec: requireString(
      source.scoreSpec,
      "run manifest.scoreSpec",
    ),
    suite,
    subject,
    environment,
    ...(model === undefined ? {} : { model }),
    budget: Object.freeze({
      timeoutMs: requireInteger(
        budgetSource.timeoutMs,
        "run manifest.budget.timeoutMs",
      ),
      concurrency: requireInteger(
        budgetSource.concurrency,
        "run manifest.budget.concurrency",
      ),
      ...(budgetSource.maxTokens === undefined
        ? {}
        : {
            maxTokens: requireInteger(
              budgetSource.maxTokens,
              "run manifest.budget.maxTokens",
            ),
          }),
      ...(budgetSource.maxCostUsd === undefined
        ? {}
        : {
            maxCostUsd: requireFiniteNumber(
              budgetSource.maxCostUsd,
              "run manifest.budget.maxCostUsd",
            ),
          }),
    }),
    repetitions: requireInteger(
      source.repetitions,
      "run manifest.repetitions",
    ),
    startedAt,
    ...(source.metadata === undefined
      ? {}
      : {
          metadata: requireRecord(
            source.metadata,
            "run manifest.metadata",
          ),
        }),
  }) as EvaluationRunManifest;
}

export function parseRunSummary(
  value: unknown,
): EvaluationRunSummary {
  const source = requireRecord(value, "run summary");
  if (source.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid("source run uses an unsupported summary contract");
  }
  const runId = requireString(source.runId, "run summary.runId");
  assertIdentifier(runId, "run summary.runId");
  const gateEvaluation = requireRecord(
    source.gateEvaluation,
    "run summary.gateEvaluation",
  ) as unknown as GateEvaluation;
  assertGateEvaluation(gateEvaluation);
  const taskCounts = parseTaskCounts(source.taskCounts);
  const taskResultArtifacts = requireArray(
    source.taskResultArtifacts,
    "run summary.taskResultArtifacts",
  ).map((item, index) =>
    parseArtifactReference(
      item,
      `run summary.taskResultArtifacts[${index}]`,
    )
  );
  const startedAt = requireString(
    source.startedAt,
    "run summary.startedAt",
  );
  const finishedAt = requireString(
    source.finishedAt,
    "run summary.finishedAt",
  );
  assertIsoTimestamp(startedAt, "run summary.startedAt");
  assertIsoTimestamp(finishedAt, "run summary.finishedAt");
  const compositeScore = source.compositeScore === undefined
    ? undefined
    : parseCompositeScore(
        source.compositeScore,
        "run summary.compositeScore",
      );
  const failure = source.failure === undefined
    ? undefined
    : parseEvaluationFailure(source.failure);

  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    runId,
    ...(source.parentRunId === undefined
      ? {}
      : {
          parentRunId: requireString(
            source.parentRunId,
            "run summary.parentRunId",
          ),
        }),
    scoreSpec: requireString(
      source.scoreSpec,
      "run summary.scoreSpec",
    ),
    status: requireOneOf(
      source.status,
      RUN_STATUSES,
      "run summary.status",
    ),
    startedAt,
    finishedAt,
    durationMs: requireInteger(
      source.durationMs,
      "run summary.durationMs",
    ),
    taskCounts,
    metrics: requireMetricMap(
      source.metrics,
      "run summary.metrics",
    ),
    gateEvaluation,
    ...(compositeScore === undefined
      ? {}
      : { compositeScore }),
    ...(failure === undefined ? {} : { failure }),
    lessonIds: Object.freeze(
      requireArray(
        source.lessonIds,
        "run summary.lessonIds",
      ).map((item, index) =>
        requireString(item, `run summary.lessonIds[${index}]`)
      ),
    ),
    taskResultArtifacts: Object.freeze(taskResultArtifacts),
  });
}

function parseSuiteIdentity(value: unknown): SuiteIdentity {
  const source = requireRecord(value, "run manifest.suite");
  const datasetHash = requireString(
    source.datasetHash,
    "run manifest.suite.datasetHash",
  );
  assertSha256(datasetHash, "run manifest.suite.datasetHash");
  return Object.freeze({
    id: requireString(source.id, "run manifest.suite.id"),
    name: requireString(source.name, "run manifest.suite.name"),
    version: requireString(
      source.version,
      "run manifest.suite.version",
    ),
    split: requireOneOf(
      source.split,
      ["dev", "holdout", "release"],
      "run manifest.suite.split",
    ),
    datasetHash,
  });
}

function parseSubjectIdentity(value: unknown): SubjectIdentity {
  const source = requireRecord(value, "run manifest.subject");
  return Object.freeze({
    bumblebeeCommit: requireString(
      source.bumblebeeCommit,
      "run manifest.subject.bumblebeeCommit",
    ),
    workspaceClean: requireBoolean(
      source.workspaceClean,
      "run manifest.subject.workspaceClean",
    ),
    piVersion: requireString(
      source.piVersion,
      "run manifest.subject.piVersion",
    ),
  });
}

function parseEnvironmentIdentity(
  value: unknown,
): EnvironmentIdentity {
  const source = requireRecord(value, "run manifest.environment");
  return Object.freeze({
    nodeVersion: requireString(
      source.nodeVersion,
      "run manifest.environment.nodeVersion",
    ),
    platform: requireString(
      source.platform,
      "run manifest.environment.platform",
    ),
    arch: requireString(
      source.arch,
      "run manifest.environment.arch",
    ),
    hardwareProfile: requireString(
      source.hardwareProfile,
      "run manifest.environment.hardwareProfile",
    ),
  });
}

function parseModelIdentity(value: unknown): ModelIdentity {
  const source = requireRecord(value, "run manifest.model");
  return Object.freeze({
    provider: requireString(
      source.provider,
      "run manifest.model.provider",
    ),
    id: requireString(source.id, "run manifest.model.id"),
    ...(source.thinkingLevel === undefined
      ? {}
      : {
          thinkingLevel: requireString(
            source.thinkingLevel,
            "run manifest.model.thinkingLevel",
          ),
        }),
  });
}

function parseTaskCounts(value: unknown): EvaluationTaskCounts {
  const source = requireRecord(value, "run summary.taskCounts");
  const counts = Object.freeze({
    passed: requireInteger(
      source.passed,
      "run summary.taskCounts.passed",
    ),
    failed: requireInteger(
      source.failed,
      "run summary.taskCounts.failed",
    ),
    cancelled: requireInteger(
      source.cancelled,
      "run summary.taskCounts.cancelled",
    ),
    invalid: requireInteger(
      source.invalid,
      "run summary.taskCounts.invalid",
    ),
    total: requireInteger(
      source.total,
      "run summary.taskCounts.total",
    ),
  });
  if (
    counts.passed +
      counts.failed +
      counts.cancelled +
      counts.invalid !==
    counts.total
  ) {
    invalid("source task counts do not add up");
  }
  return counts;
}

function parseCompositeScore(
  value: unknown,
  field: string,
): CompositeScore {
  const source = requireRecord(value, field);
  if (source.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid(`${field} uses an unsupported contract`);
  }
  const qualification = requireOneOf(
    source.qualification,
    QUALIFICATION_STATUSES,
    `${field}.qualification`,
  );
  const score = source.score === null
    ? null
    : requireFiniteNumber(source.score, `${field}.score`);
  if (
    (qualification === "qualified" && score === null) ||
    (qualification !== "qualified" && score !== null) ||
    (score !== null && (score < 0 || score > 100))
  ) {
    invalid(`${field} score contradicts qualification`);
  }
  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec: requireString(
      source.scoreSpec,
      `${field}.scoreSpec`,
    ),
    qualification,
    score,
    components: Object.freeze(
      requireArray(source.components, `${field}.components`).map(
        (item) => item as CompositeScore["components"][number],
      ),
    ),
  });
}

function parseEvaluationFailure(value: unknown): EvaluationFailure {
  const source = requireRecord(value, "run summary.failure");
  return Object.freeze({
    category: requireOneOf(
      source.category,
      [
        "bumblebee",
        "model",
        "adapter",
        "infrastructure",
        "dataset",
        "expected-policy",
      ],
      "run summary.failure.category",
    ),
    code: requireString(
      source.code,
      "run summary.failure.code",
    ),
    message: requireString(
      source.message,
      "run summary.failure.message",
    ),
    ...(source.retryable === undefined
      ? {}
      : {
          retryable: requireBoolean(
            source.retryable,
            "run summary.failure.retryable",
          ),
        }),
  });
}
