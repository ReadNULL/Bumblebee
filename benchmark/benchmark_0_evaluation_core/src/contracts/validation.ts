import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";

import {
  ARTIFACT_KINDS,
  EVALUATION_CONTRACT_VERSION,
  FAILURE_CATEGORIES,
  GATE_KINDS,
  GATE_OPERATORS,
  LESSON_STATUSES,
  RUN_STATUSES,
  SUITE_SPLITS,
  TASK_STATUSES,
  type ArtifactReference,
  type EvaluationFailure,
  type EvaluationTaskResultInput,
  type FinalizeEvaluationRunInput,
  type GateEvaluation,
  type LessonRevisionInput,
  type ScoreSpec,
  type StartEvaluationRunInput,
  type TokenUsage,
} from "./types.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WEIGHT_EPSILON = 1e-9;

export function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    invalid(`${field} must be a portable identifier`, { field, value });
  }
}

export function assertStartEvaluationRunInput(
  input: StartEvaluationRunInput,
): void {
  if (input.parentRunId !== undefined) {
    assertIdentifier(input.parentRunId, "parentRunId");
  }

  assertIdentifier(input.scoreSpec, "scoreSpec");
  assertIdentifier(input.suite.id, "suite.id");
  assertNonEmpty(input.suite.name, "suite.name");
  assertIdentifier(input.suite.version, "suite.version");
  assertMember(input.suite.split, SUITE_SPLITS, "suite.split");
  assertSha256(input.suite.datasetHash, "suite.datasetHash");

  assertNonEmpty(input.subject.bumblebeeCommit, "subject.bumblebeeCommit");
  assertNonEmpty(input.subject.piVersion, "subject.piVersion");
  assertNonEmpty(input.environment.nodeVersion, "environment.nodeVersion");
  assertNonEmpty(input.environment.platform, "environment.platform");
  assertNonEmpty(input.environment.arch, "environment.arch");
  assertNonEmpty(
    input.environment.hardwareProfile,
    "environment.hardwareProfile",
  );

  if (input.model !== undefined) {
    assertNonEmpty(input.model.provider, "model.provider");
    assertNonEmpty(input.model.id, "model.id");
    if (input.model.thinkingLevel !== undefined) {
      assertNonEmpty(input.model.thinkingLevel, "model.thinkingLevel");
    }
  }

  assertPositiveInteger(input.budget.timeoutMs, "budget.timeoutMs");
  assertPositiveInteger(input.budget.concurrency, "budget.concurrency");
  assertOptionalNonNegativeInteger(
    input.budget.maxTokens,
    "budget.maxTokens",
  );
  assertOptionalNonNegativeNumber(
    input.budget.maxCostUsd,
    "budget.maxCostUsd",
  );
  assertPositiveInteger(input.repetitions, "repetitions");

  if (input.startedAt !== undefined) {
    assertIsoTimestamp(input.startedAt, "startedAt");
  }
}

export function assertEvaluationTaskResultInput(
  input: EvaluationTaskResultInput,
): void {
  assertIdentifier(input.taskId, "taskId");
  assertPositiveInteger(input.trial, "trial");
  assertMember(input.status, TASK_STATUSES, "status");
  assertIsoTimestamp(input.startedAt, "startedAt");
  assertIsoTimestamp(input.finishedAt, "finishedAt");
  assertNonNegativeNumber(input.durationMs, "durationMs");
  assertOptionalRange(input.reward, 0, 1, "reward");
  assertMetricMap(input.metrics ?? {}, "metrics");
  assertOptionalNonNegativeNumber(input.costUsd, "costUsd");

  if (input.tokens !== undefined) {
    assertTokenUsage(input.tokens);
  }

  if (input.status === "passed" && input.failure !== undefined) {
    invalid("passed task cannot contain failure details", {
      taskId: input.taskId,
    });
  }

  if (
    (input.status === "failed" || input.status === "invalid") &&
    input.failure === undefined
  ) {
    invalid(`${input.status} task must contain failure details`, {
      taskId: input.taskId,
    });
  }

  if (input.failure !== undefined) {
    assertEvaluationFailure(input.failure, "failure");
  }

  for (const artifact of input.artifacts ?? []) {
    assertArtifactReference(artifact);
  }
}

export function assertFinalizeEvaluationRunInput(
  input: FinalizeEvaluationRunInput,
): void {
  assertMember(input.status, RUN_STATUSES, "status");
  if (input.finishedAt !== undefined) {
    assertIsoTimestamp(input.finishedAt, "finishedAt");
  }

  assertMetricMap(input.metrics, "metrics");
  assertGateEvaluation(input.gateEvaluation);

  if (input.failure !== undefined) {
    assertEvaluationFailure(input.failure, "failure");
  }

  if (input.status === "completed" && input.failure !== undefined) {
    invalid("completed run cannot contain run-level failure details");
  }

  if (
    input.status === "invalid" &&
    input.gateEvaluation.status !== "invalid"
  ) {
    invalid("invalid run must have an invalid gate evaluation");
  }

  for (const lessonId of input.lessonIds ?? []) {
    assertIdentifier(lessonId, "lessonId");
  }

  if (
    input.compositeScore !== undefined &&
    input.compositeScore.scoreSpec !== input.gateEvaluation.scoreSpec
  ) {
    invalid("composite score and gate evaluation use different specs");
  }
}

export function assertScoreSpec(spec: ScoreSpec): void {
  if (spec.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid("unsupported score spec contract version", {
      contractVersion: spec.contractVersion,
    });
  }

  assertIdentifier(spec.id, "scoreSpec.id");
  if (spec.components.length === 0) {
    invalid("score spec must contain at least one component");
  }

  const componentIds = new Set<string>();
  let totalWeight = 0;
  for (const component of spec.components) {
    assertIdentifier(component.id, "component.id");
    if (componentIds.has(component.id)) {
      invalid("score spec contains a duplicate component", {
        componentId: component.id,
      });
    }
    componentIds.add(component.id);
    assertRange(component.weight, 0, 1, "component.weight", false);
    totalWeight += component.weight;
  }

  if (Math.abs(totalWeight - 1) > WEIGHT_EPSILON) {
    invalid("score component weights must sum to 1", { totalWeight });
  }

  const gateIds = new Set<string>();
  for (const gate of spec.hardGates) {
    assertIdentifier(gate.id, "gate.id");
    assertIdentifier(gate.metric, "gate.metric");
    assertMember(gate.kind, GATE_KINDS, "gate.kind");
    assertMember(gate.operator, GATE_OPERATORS, "gate.operator");
    assertFiniteNumber(gate.threshold, "gate.threshold");

    if (gateIds.has(gate.id)) {
      invalid("score spec contains a duplicate gate", {
        gateId: gate.id,
      });
    }
    gateIds.add(gate.id);
  }
}

export function assertGateEvaluation(evaluation: GateEvaluation): void {
  if (evaluation.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid("unsupported gate evaluation contract version");
  }
  assertIdentifier(evaluation.scoreSpec, "gateEvaluation.scoreSpec");

  const gateIds = new Set<string>();
  for (const decision of evaluation.decisions) {
    assertIdentifier(decision.gateId, "decision.gateId");
    assertIdentifier(decision.metric, "decision.metric");
    assertMember(decision.kind, GATE_KINDS, "decision.kind");
    assertMember(decision.operator, GATE_OPERATORS, "decision.operator");
    assertFiniteNumber(decision.threshold, "decision.threshold");
    if (decision.actual !== undefined) {
      assertFiniteNumber(decision.actual, "decision.actual");
    }
    if (
      decision.status !== "passed" &&
      decision.status !== "failed" &&
      decision.status !== "missing"
    ) {
      invalid("decision.status is invalid", {
        status: decision.status,
      });
    }
    if (
      (decision.status === "missing" && decision.actual !== undefined) ||
      (decision.status !== "missing" && decision.actual === undefined)
    ) {
      invalid("gate decision actual value contradicts its status", {
        gateId: decision.gateId,
        status: decision.status,
      });
    }
    if (
      decision.actual !== undefined &&
      decision.status !==
        (compareGate(
          decision.actual,
          decision.operator,
          decision.threshold,
        )
          ? "passed"
          : "failed")
    ) {
      invalid("gate decision does not match its actual value", {
        gateId: decision.gateId,
      });
    }
    if (gateIds.has(decision.gateId)) {
      invalid("gate evaluation contains a duplicate decision", {
        gateId: decision.gateId,
      });
    }
    gateIds.add(decision.gateId);
  }

  const expectedStatus =
    evaluation.decisions.some(
      (decision) =>
        decision.status === "missing" ||
        (decision.kind === "validity" && decision.status === "failed"),
    )
      ? "invalid"
      : evaluation.decisions.some(
            (decision) =>
              decision.kind === "qualification" &&
              decision.status === "failed",
          )
        ? "not-qualified"
        : "qualified";
  if (evaluation.status !== expectedStatus) {
    invalid("gate evaluation status contradicts its decisions", {
      actual: evaluation.status,
      expected: expectedStatus,
    });
  }
}

export function assertArtifactReference(
  artifact: ArtifactReference,
): void {
  if (artifact.contractVersion !== EVALUATION_CONTRACT_VERSION) {
    invalid("unsupported artifact contract version");
  }
  assertIdentifier(artifact.artifactId, "artifactId");
  assertIdentifier(artifact.runId, "runId");
  assertNonEmpty(artifact.relativePath, "relativePath");
  assertMember(artifact.kind, ARTIFACT_KINDS, "artifact.kind");
  assertNonEmpty(artifact.mediaType, "artifact.mediaType");
  assertNonNegativeInteger(artifact.byteLength, "artifact.byteLength");
  assertSha256(artifact.sha256, "artifact.sha256");
  assertIsoTimestamp(artifact.createdAt, "artifact.createdAt");
}

export function assertLessonRevisionInput(
  input: LessonRevisionInput,
): void {
  assertIdentifier(input.lessonId, "lessonId");
  assertNonEmpty(input.title, "title");
  if (
    !FAILURE_CATEGORIES.includes(
      input.category as (typeof FAILURE_CATEGORIES)[number],
    ) &&
    input.category !== "success-pattern"
  ) {
    invalid("lesson.category is invalid", { category: input.category });
  }
  assertMember(input.status, LESSON_STATUSES, "lesson.status");
  assertNonEmptyArray(input.evidenceRunIds, "evidenceRunIds");
  input.evidenceRunIds.forEach((runId) => {
    assertIdentifier(runId, "evidenceRunId");
  });
  assertNonEmpty(input.evidence, "evidence");
  assertNonEmpty(input.hypothesis, "hypothesis");
  assertNonEmpty(input.changeBoundary, "changeBoundary");
  assertNonEmptyArray(input.expectedMetrics, "expectedMetrics");
  input.expectedMetrics.forEach((metric) => {
    assertIdentifier(metric, "expectedMetric");
  });
  input.risks.forEach((risk) => {
    assertNonEmpty(risk, "risk");
  });

  if (input.developmentResult !== undefined) {
    assertNonEmpty(input.developmentResult, "developmentResult");
  }
  if (input.holdoutResult !== undefined) {
    assertNonEmpty(input.holdoutResult, "holdoutResult");
  }
  if (input.relatedCommit !== undefined) {
    assertNonEmpty(input.relatedCommit, "relatedCommit");
  }
  for (const runId of input.verificationRunIds ?? []) {
    assertIdentifier(runId, "verificationRunId");
  }
}

export function assertMetricMap(
  metrics: Readonly<Record<string, number>>,
  field: string,
): void {
  for (const [key, value] of Object.entries(metrics)) {
    assertIdentifier(key, `${field}.key`);
    assertFiniteNumber(value, `${field}.${key}`);
  }
}

export function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    invalid(`${field} must be a lowercase SHA-256 hex digest`, {
      field,
      value,
    });
  }
}

export function assertIsoTimestamp(value: string, field: string): void {
  if (
    value.trim().length === 0 ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    invalid(`${field} must be an ISO-8601 UTC timestamp`, {
      field,
      value,
    });
  }
}

function assertEvaluationFailure(
  failure: EvaluationFailure,
  field: string,
): void {
  assertMember(failure.category, FAILURE_CATEGORIES, `${field}.category`);
  assertIdentifier(failure.code, `${field}.code`);
  assertNonEmpty(failure.message, `${field}.message`);
}

function assertTokenUsage(tokens: TokenUsage): void {
  assertNonNegativeInteger(tokens.input, "tokens.input");
  assertNonNegativeInteger(tokens.output, "tokens.output");
  assertOptionalNonNegativeInteger(tokens.cacheRead, "tokens.cacheRead");
  assertOptionalNonNegativeInteger(tokens.cacheWrite, "tokens.cacheWrite");
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    invalid(`${field} must not be empty`, { field });
  }
}

function assertNonEmptyArray(
  values: readonly unknown[],
  field: string,
): void {
  if (values.length === 0) {
    invalid(`${field} must not be empty`, { field });
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    invalid(`${field} must be a positive integer`, { field, value });
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer`, { field, value });
  }
}

function assertOptionalNonNegativeInteger(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined) {
    assertNonNegativeInteger(value, field);
  }
}

function assertNonNegativeNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    invalid(`${field} must be a non-negative finite number`, {
      field,
      value,
    });
  }
}

function assertOptionalNonNegativeNumber(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined) {
    assertNonNegativeNumber(value, field);
  }
}

function assertOptionalRange(
  value: number | undefined,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (value !== undefined) {
    assertRange(value, minimum, maximum, field);
  }
}

function assertRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
  includeMinimum = true,
): void {
  const belowMinimum = includeMinimum ? value < minimum : value <= minimum;
  if (!Number.isFinite(value) || belowMinimum || value > maximum) {
    invalid(`${field} is outside the allowed range`, {
      field,
      maximum,
      minimum,
      value,
    });
  }
}

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    invalid(`${field} must be a finite number`, { field, value });
  }
}

function compareGate(
  actual: number,
  operator: "eq" | "gte" | "lte",
  threshold: number,
): boolean {
  switch (operator) {
    case "eq":
      return actual === threshold;
    case "gte":
      return actual >= threshold;
    case "lte":
      return actual <= threshold;
  }
}

function assertMember<Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): asserts value is Value {
  if (!allowed.includes(value as Value)) {
    invalid(`${field} is invalid`, { allowed, field, value });
  }
}

function invalid(
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context,
  });
}
