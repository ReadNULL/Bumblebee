import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  EvaluationFailure,
  TokenUsage,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  AGENTDOJO_APPROVAL_POLICIES,
  AGENTDOJO_CONTRACT_VERSION,
  AGENTDOJO_SUBJECT_PROFILES,
  PI_INVOCATION_STATUSES,
  invalid,
  requireArray,
  requireBoolean,
  requireIsoDate,
  requireMultilineString,
  requireNonNegativeInteger,
  requireNonNegativeNumber,
  requireOneOf,
  requirePositiveInteger,
  requireRecord,
  requireSha256,
  requireString,
  type AgentDojoAttackCase,
  type AgentDojoCleanCase,
  type AgentDojoDatasetIdentity,
  type AgentDojoInjectionUtilityCase,
  type AgentDojoManifest,
  type AgentDojoModelIdentity,
  type AgentDojoSelection,
  type AgentDojoSubjectIdentity,
  type NormalizedAgentDojoRun,
  type PiInvocationTrace,
} from "../contracts/index.js";

export async function readAgentDojoResult(
  path: string,
  manifest: AgentDojoManifest,
): Promise<NormalizedAgentDojoRun> {
  const bytes = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause: unknown) {
    invalid("AgentDojo result is not valid UTF-8 JSON", {
      cause: String(cause),
      path,
    });
  }
  return parseAgentDojoResult(value, manifest, {
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceFileName: basename(path),
  });
}

export function parseAgentDojoResult(
  value: unknown,
  manifest: AgentDojoManifest,
  provenance: {
    readonly sourceSha256: string;
    readonly sourceFileName: string;
  },
): NormalizedAgentDojoRun {
  const source = requireRecord(value, "result");
  if (source.contractVersion !== AGENTDOJO_CONTRACT_VERSION) {
    invalid("unsupported AgentDojo result contract version");
  }
  const status = requireOneOf(
    source.status,
    ["completed", "failed"] as const,
    "result.status",
  );
  const startedAt = requireIsoDate(
    source.startedAt,
    "result.startedAt",
  );
  const finishedAt = requireIsoDate(
    source.finishedAt,
    "result.finishedAt",
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    invalid("AgentDojo result finishes before it starts");
  }

  const selection = parseSelection(source.selection);
  const cleanCases = parseCleanCases(source.cleanCases);
  const attackCases = parseAttackCases(source.attackCases);
  const injectionUtilityCases = parseInjectionUtilityCases(
    source.injectionUtilityCases,
  );
  const traces = parseTraces(source.traces);
  const failure = source.failure === undefined
    ? undefined
    : parseFailure(source.failure, "result.failure");

  if (status === "completed") {
    if (failure !== undefined) {
      invalid("completed AgentDojo result must not have failure");
    }
    assertCompletedCoverage(
      selection,
      cleanCases,
      attackCases,
      injectionUtilityCases,
      traces,
    );
  } else if (failure === undefined) {
    invalid("failed AgentDojo result requires failure");
  }

  const result = {
    contractVersion: AGENTDOJO_CONTRACT_VERSION,
    adapterRunId: requireString(
      source.adapterRunId,
      "result.adapterRunId",
    ),
    adapterVersion: requireString(
      source.adapterVersion,
      "result.adapterVersion",
    ),
    status,
    startedAt,
    finishedAt,
    durationMs: requireNonNegativeInteger(
      source.durationMs,
      "result.durationMs",
    ),
    dataset: parseDataset(source.dataset),
    subject: parseSubject(source.subject),
    model: parseModel(source.model),
    bridge: parseBridge(source.bridge),
    selection,
    cleanCases,
    attackCases,
    injectionUtilityCases,
    traces,
    ...(failure === undefined ? {} : { failure }),
    provenance: Object.freeze({
      sourceSha256: requireSha256(
        provenance.sourceSha256,
        "provenance.sourceSha256",
      ),
      sourceFileName: requireString(
        provenance.sourceFileName,
        "provenance.sourceFileName",
      ),
    }),
  } satisfies NormalizedAgentDojoRun;

  // Structural parsing is independent from eligibility; gates report drift.
  void manifest;
  return Object.freeze(result);
}

function parseDataset(value: unknown): AgentDojoDatasetIdentity {
  const source = requireRecord(value, "result.dataset");
  return Object.freeze({
    package: requireString(
      source.package,
      "result.dataset.package",
    ),
    packageVersion: requireString(
      source.packageVersion,
      "result.dataset.packageVersion",
    ),
    benchmarkVersion: requireString(
      source.benchmarkVersion,
      "result.dataset.benchmarkVersion",
    ),
    suite: requireString(
      source.suite,
      "result.dataset.suite",
    ),
    attack: requireString(
      source.attack,
      "result.dataset.attack",
    ),
    contentSha256: requireSha256(
      source.contentSha256,
      "result.dataset.contentSha256",
    ),
    userTaskCount: requireNonNegativeInteger(
      source.userTaskCount,
      "result.dataset.userTaskCount",
    ),
    injectionTaskCount: requireNonNegativeInteger(
      source.injectionTaskCount,
      "result.dataset.injectionTaskCount",
    ),
    toolCount: requireNonNegativeInteger(
      source.toolCount,
      "result.dataset.toolCount",
    ),
  });
}

function parseSubject(value: unknown): AgentDojoSubjectIdentity {
  const source = requireRecord(value, "result.subject");
  const profile = requireOneOf(
    source.profile,
    AGENTDOJO_SUBJECT_PROFILES,
    "result.subject.profile",
  );
  const bumblebeeCommit = source.bumblebeeCommit === undefined
    ? undefined
    : requireString(
      source.bumblebeeCommit,
      "result.subject.bumblebeeCommit",
    );
  const extensionSource = source.extensionSource === undefined
    ? undefined
    : requireString(
      source.extensionSource,
      "result.subject.extensionSource",
    );
  return Object.freeze({
    profile,
    piVersion: requireString(
      source.piVersion,
      "result.subject.piVersion",
    ),
    ...(bumblebeeCommit === undefined
      ? {}
      : { bumblebeeCommit }),
    ...(extensionSource === undefined
      ? {}
      : { extensionSource }),
    workspaceClean: requireBoolean(
      source.workspaceClean,
      "result.subject.workspaceClean",
    ),
  });
}

function parseModel(value: unknown): AgentDojoModelIdentity {
  const source = requireRecord(value, "result.model");
  const thinkingLevel = source.thinkingLevel === undefined
    ? undefined
    : requireString(
      source.thinkingLevel,
      "result.model.thinkingLevel",
    );
  return Object.freeze({
    provider: requireString(
      source.provider,
      "result.model.provider",
    ),
    model: requireString(
      source.model,
      "result.model.model",
    ),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });
}

function parseBridge(value: unknown) {
  const source = requireRecord(value, "result.bridge");
  return Object.freeze({
    protocolVersion: requirePositiveInteger(
      source.protocolVersion,
      "result.bridge.protocolVersion",
    ),
    approvalPolicy: requireOneOf(
      source.approvalPolicy,
      AGENTDOJO_APPROVAL_POLICIES,
      "result.bridge.approvalPolicy",
    ),
    systemPromptSha256: requireSha256(
      source.systemPromptSha256,
      "result.bridge.systemPromptSha256",
    ),
    maxResponseBytes: requirePositiveInteger(
      source.maxResponseBytes,
      "result.bridge.maxResponseBytes",
    ),
  });
}

function parseSelection(value: unknown): AgentDojoSelection {
  const source = requireRecord(value, "result.selection");
  return Object.freeze({
    userTaskIds: parseUniqueStrings(
      source.userTaskIds,
      "result.selection.userTaskIds",
    ),
    injectionTaskIds: parseUniqueStrings(
      source.injectionTaskIds,
      "result.selection.injectionTaskIds",
    ),
  });
}

function parseCleanCases(
  value: unknown,
): readonly AgentDojoCleanCase[] {
  const cases = requireArray(value, "result.cleanCases").map(
    (item, index) => {
      const source = requireRecord(
        item,
        `result.cleanCases.${index}`,
      );
      return Object.freeze({
        userTaskId: requireString(
          source.userTaskId,
          `result.cleanCases.${index}.userTaskId`,
        ),
        utility: requireBoolean(
          source.utility,
          `result.cleanCases.${index}.utility`,
        ),
      });
    },
  );
  assertUnique(
    cases.map((item) => item.userTaskId),
    "result.cleanCases",
  );
  return Object.freeze(cases);
}

function parseAttackCases(
  value: unknown,
): readonly AgentDojoAttackCase[] {
  const cases = requireArray(value, "result.attackCases").map(
    (item, index) => {
      const source = requireRecord(
        item,
        `result.attackCases.${index}`,
      );
      return Object.freeze({
        userTaskId: requireString(
          source.userTaskId,
          `result.attackCases.${index}.userTaskId`,
        ),
        injectionTaskId: requireString(
          source.injectionTaskId,
          `result.attackCases.${index}.injectionTaskId`,
        ),
        utility: requireBoolean(
          source.utility,
          `result.attackCases.${index}.utility`,
        ),
        security: requireBoolean(
          source.security,
          `result.attackCases.${index}.security`,
        ),
      });
    },
  );
  assertUnique(
    cases.map(
      (item) =>
        `${item.userTaskId}\u0000${item.injectionTaskId}`,
    ),
    "result.attackCases",
  );
  return Object.freeze(cases);
}

function parseInjectionUtilityCases(
  value: unknown,
): readonly AgentDojoInjectionUtilityCase[] {
  const cases = requireArray(
    value,
    "result.injectionUtilityCases",
  ).map((item, index) => {
    const source = requireRecord(
      item,
      `result.injectionUtilityCases.${index}`,
    );
    return Object.freeze({
      injectionTaskId: requireString(
        source.injectionTaskId,
        `result.injectionUtilityCases.${index}.injectionTaskId`,
      ),
      utility: requireBoolean(
        source.utility,
        `result.injectionUtilityCases.${index}.utility`,
      ),
    });
  });
  assertUnique(
    cases.map((item) => item.injectionTaskId),
    "result.injectionUtilityCases",
  );
  return Object.freeze(cases);
}

function parseTraces(value: unknown): readonly PiInvocationTrace[] {
  const traces = requireArray(value, "result.traces").map(
    (item, index) => {
      const source = requireRecord(
        item,
        `result.traces.${index}`,
      );
      const startedAt = requireIsoDate(
        source.startedAt,
        `result.traces.${index}.startedAt`,
      );
      const finishedAt = requireIsoDate(
        source.finishedAt,
        `result.traces.${index}.finishedAt`,
      );
      if (Date.parse(finishedAt) < Date.parse(startedAt)) {
        invalid(`result.traces.${index} finishes before it starts`);
      }
      const status = requireOneOf(
        source.status,
        PI_INVOCATION_STATUSES,
        `result.traces.${index}.status`,
      );
      const failure = source.failure === undefined
        ? undefined
        : parseFailure(
          source.failure,
          `result.traces.${index}.failure`,
        );
      if (status === "completed" && failure !== undefined) {
        invalid(
          `result.traces.${index} completed with a failure`,
        );
      }
      if (status !== "completed" && failure === undefined) {
        invalid(
          `result.traces.${index} failed without a failure`,
        );
      }
      const tokens = source.tokens === undefined
        ? undefined
        : parseTokens(
          source.tokens,
          `result.traces.${index}.tokens`,
        );
      const costUsd = source.costUsd === undefined
        ? undefined
        : requireNonNegativeNumber(
          source.costUsd,
          `result.traces.${index}.costUsd`,
        );
      return Object.freeze({
        invocationId: requireString(
          source.invocationId,
          `result.traces.${index}.invocationId`,
        ),
        querySha256: requireSha256(
          source.querySha256,
          `result.traces.${index}.querySha256`,
        ),
        status,
        startedAt,
        finishedAt,
        durationMs: requireNonNegativeInteger(
          source.durationMs,
          `result.traces.${index}.durationMs`,
        ),
        toolCallCount: requireNonNegativeInteger(
          source.toolCallCount,
          `result.traces.${index}.toolCallCount`,
        ),
        permissionPromptCount: requireNonNegativeInteger(
          source.permissionPromptCount,
          `result.traces.${index}.permissionPromptCount`,
        ),
        ...(tokens === undefined ? {} : { tokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(failure === undefined ? {} : { failure }),
      });
    },
  );
  assertUnique(
    traces.map((trace) => trace.invocationId),
    "result.traces",
  );
  return Object.freeze(traces);
}

function parseTokens(value: unknown, field: string): TokenUsage {
  const source = requireRecord(value, field);
  const cacheRead = source.cacheRead === undefined
    ? undefined
    : requireNonNegativeInteger(
      source.cacheRead,
      `${field}.cacheRead`,
    );
  const cacheWrite = source.cacheWrite === undefined
    ? undefined
    : requireNonNegativeInteger(
      source.cacheWrite,
      `${field}.cacheWrite`,
    );
  return Object.freeze({
    input: requireNonNegativeInteger(
      source.input,
      `${field}.input`,
    ),
    output: requireNonNegativeInteger(
      source.output,
      `${field}.output`,
    ),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  });
}

function parseFailure(
  value: unknown,
  field: string,
): EvaluationFailure {
  const source = requireRecord(value, field);
  const category = requireOneOf(
    source.category,
    [
      "bumblebee",
      "model",
      "adapter",
      "infrastructure",
      "dataset",
      "expected-policy",
    ] as const,
    `${field}.category`,
  );
  const retryable = source.retryable === undefined
    ? undefined
    : requireBoolean(source.retryable, `${field}.retryable`);
  return Object.freeze({
    category,
    code: requireString(source.code, `${field}.code`),
    message: requireMultilineString(
      source.message,
      `${field}.message`,
    ),
    ...(retryable === undefined ? {} : { retryable }),
  });
}

function parseUniqueStrings(
  value: unknown,
  field: string,
): readonly string[] {
  const values = requireArray(value, field).map((item, index) =>
    requireString(item, `${field}.${index}`)
  );
  assertUnique(values, field);
  return Object.freeze(values);
}

function assertUnique(
  values: readonly string[],
  field: string,
): void {
  if (new Set(values).size !== values.length) {
    invalid(`${field} contains duplicate entries`);
  }
}

function assertCompletedCoverage(
  selection: AgentDojoSelection,
  cleanCases: readonly AgentDojoCleanCase[],
  attackCases: readonly AgentDojoAttackCase[],
  injectionCases: readonly AgentDojoInjectionUtilityCase[],
  traces: readonly PiInvocationTrace[],
): void {
  assertSameSet(
    selection.userTaskIds,
    cleanCases.map((item) => item.userTaskId),
    "clean case coverage",
  );
  assertSameSet(
    selection.injectionTaskIds,
    injectionCases.map((item) => item.injectionTaskId),
    "injection utility coverage",
  );
  if (attackCases.length === 0) {
    invalid("completed AgentDojo result has no attack cases");
  }
  const users = new Set(selection.userTaskIds);
  const injections = new Set(selection.injectionTaskIds);
  const expectedAttackCaseCount = users.size * injections.size;
  if (attackCases.length !== expectedAttackCaseCount) {
    invalid(
      "attack case coverage is not the selected task Cartesian product",
      {
        actual: attackCases.length,
        expected: expectedAttackCaseCount,
      },
    );
  }
  const attackPairs = new Set(
    attackCases.map(
      (item) =>
        `${item.userTaskId}\u0000${item.injectionTaskId}`,
    ),
  );
  for (const item of attackCases) {
    if (
      !users.has(item.userTaskId) ||
      !injections.has(item.injectionTaskId)
    ) {
      invalid("attack case is outside the frozen selection");
    }
  }
  for (const userTaskId of users) {
    for (const injectionTaskId of injections) {
      if (
        !attackPairs.has(
          `${userTaskId}\u0000${injectionTaskId}`,
        )
      ) {
        invalid("attack case matrix has a missing pair", {
          userTaskId,
          injectionTaskId,
        });
      }
    }
  }
  if (traces.length === 0) {
    invalid("completed AgentDojo result has no pi traces");
  }
}

function assertSameSet(
  expected: readonly string[],
  actual: readonly string[],
  field: string,
): void {
  if (
    expected.length !== actual.length ||
    expected.some((value) => !actual.includes(value))
  ) {
    invalid(`${field} does not match the task selection`);
  }
}
