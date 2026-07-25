import {
  assertIdentifier,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../src/foundation/index.js";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  type MemoryCategory,
  type MemoryMutationResult,
  type MemoryScope,
  type MemoryUpsertInput,
} from "../../../../src/memory/index.js";
import {
  LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION,
  LONGMEMEVAL_CAPABILITIES,
  type LongMemEvalAnswerRubric,
  type LongMemEvalCase,
  type LongMemEvalCaseChecks,
  type LongMemEvalDataset,
  type LongMemEvalDatasetOrigin,
  type LongMemEvalExpectedRecord,
  type LongMemEvalMemoryEvent,
  type LongMemEvalQuery,
} from "./types.js";
import {
  invalid,
  requireArray,
  requireBoolean,
  requireIsoTimestamp,
  requireOneOf,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireStringArray,
} from "./validation.js";

const MEMORY_STATUSES = [
  "created",
  "unchanged",
  "updated",
] as const satisfies readonly MemoryMutationResult["status"][];

const ERROR_CODE_VALUES = Object.values(ERROR_CODES);
const MEMORY_SCOPE_FILTERS = [
  ...MEMORY_SCOPES,
  "all",
] as const;
const MEMORY_ACCESS_MODES = [
  "read-only",
  "read-write",
] as const;
const MEMORY_REFERENCE_PATTERN = /^(?:global|project):\S.+$/u;

export function parseLongMemEvalDataset(
  value: unknown,
): LongMemEvalDataset {
  const source = requireRecord(value, "dataset");
  if (
    source.contractVersion !==
      LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION
  ) {
    invalid("unsupported LongMemEval-Bumblebee dataset version");
  }

  const cases = requireArray(source.cases, "dataset.cases").map(
    (item, index) => parseCase(item, index),
  );
  if (cases.length === 0) {
    invalid("dataset.cases must not be empty");
  }
  assertUnique(cases.map((item) => item.id), "case id");

  return Object.freeze({
    contractVersion: LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION,
    id: requireString(source.id, "dataset.id"),
    version: requireString(source.version, "dataset.version"),
    description: requireString(
      source.description,
      "dataset.description",
    ),
    origin: parseOrigin(source.origin),
    cases: Object.freeze(cases),
  });
}

function parseOrigin(value: unknown): LongMemEvalDatasetOrigin {
  const source = requireRecord(value, "dataset.origin");
  if (
    source.benchmark !== "LongMemEval" ||
    source.relationship !==
      "capability-inspired-project-authored" ||
    source.officialLeaderboardCompatible !== false
  ) {
    invalid("dataset origin must preserve the adapted-score boundary");
  }
  return Object.freeze({
    benchmark: "LongMemEval",
    reference: requireString(
      source.reference,
      "dataset.origin.reference",
    ),
    relationship: "capability-inspired-project-authored",
    officialLeaderboardCompatible: false,
  });
}

function parseCase(value: unknown, index: number): LongMemEvalCase {
  const field = `dataset.cases[${index}]`;
  const source = requireRecord(value, field);
  const workspaces = requireStringArray(
    source.workspaces,
    `${field}.workspaces`,
    false,
  );
  assertUnique(workspaces, `${field} workspace`);
  workspaces.forEach((workspace) => {
    assertIdentifier(workspace, `${field}.workspace`);
  });

  const events = requireArray(source.events, `${field}.events`).map(
    (item, eventIndex) =>
      parseEvent(item, `${field}.events[${eventIndex}]`, workspaces),
  );
  if (events.length === 0) {
    invalid(`${field}.events must not be empty`);
  }
  assertChronological(events, field);

  const query = parseQuery(source.query, `${field}.query`);
  if (!workspaces.includes(query.workspace)) {
    invalid(`${field}.query references an unknown workspace`);
  }

  const id = requireString(source.id, `${field}.id`);
  assertIdentifier(id, `${field}.id`);
  return Object.freeze({
    id,
    capability: requireOneOf(
      source.capability,
      LONGMEMEVAL_CAPABILITIES,
      `${field}.capability`,
    ),
    description: requireString(
      source.description,
      `${field}.description`,
    ),
    workspaces,
    events: Object.freeze(events),
    query,
    answer: parseAnswer(source.answer, `${field}.answer`),
    ...(source.checks === undefined
      ? {}
      : {
          checks: parseChecks(
            source.checks,
            `${field}.checks`,
            workspaces,
          ),
        }),
  });
}

function parseEvent(
  value: unknown,
  field: string,
  workspaces: readonly string[],
): LongMemEvalMemoryEvent {
  const source = requireRecord(value, field);
  const type = requireOneOf(
    source.type,
    ["upsert", "reject-upsert", "compact", "resume"] as const,
    `${field}.type`,
  );
  const workspace = requireString(
    source.workspace,
    `${field}.workspace`,
  );
  if (!workspaces.includes(workspace)) {
    invalid(`${field} references an unknown workspace`);
  }
  const at = requireIsoTimestamp(source.at, `${field}.at`);

  if (type === "compact" || type === "resume") {
    return Object.freeze({ type, at, workspace });
  }

  const input = parseMemoryInput(source.input, `${field}.input`);
  if (type === "upsert") {
    return Object.freeze({
      type,
      at,
      workspace,
      input,
      expectedStatus: requireOneOf(
        source.expectedStatus,
        MEMORY_STATUSES,
        `${field}.expectedStatus`,
      ),
    });
  }

  return Object.freeze({
    type,
    at,
    workspace,
    input,
    expectedErrorCode: requireOneOf(
      source.expectedErrorCode,
      ERROR_CODE_VALUES,
      `${field}.expectedErrorCode`,
    ) as ErrorCode,
  });
}

function parseMemoryInput(
  value: unknown,
  field: string,
): MemoryUpsertInput {
  const source = requireRecord(value, field);
  const pinned = source.pinned;
  if (pinned !== undefined && typeof pinned !== "boolean") {
    invalid(`${field}.pinned must be a boolean`);
  }
  const keywords = source.keywords === undefined
    ? undefined
    : requireStringArray(source.keywords, `${field}.keywords`);

  return Object.freeze({
    category: requireOneOf(
      source.category,
      MEMORY_CATEGORIES,
      `${field}.category`,
    ) as MemoryCategory,
    content: requireString(source.content, `${field}.content`),
    key: requireString(source.key, `${field}.key`),
    scope: requireOneOf(
      source.scope,
      MEMORY_SCOPES,
      `${field}.scope`,
    ) as MemoryScope,
    ...(keywords === undefined ? {} : { keywords }),
    ...(pinned === undefined ? {} : { pinned }),
  });
}

function parseQuery(
  value: unknown,
  field: string,
): LongMemEvalQuery {
  const source = requireRecord(value, field);
  const relevantKeys = parseMemoryReferences(
    source.relevantKeys,
    `${field}.relevantKeys`,
  );
  const forbiddenKeys = parseMemoryReferences(
    source.forbiddenKeys,
    `${field}.forbiddenKeys`,
  );
  const forbidden = new Set(forbiddenKeys);
  if (relevantKeys.some((key) => forbidden.has(key))) {
    invalid(`${field} contains a relevant/forbidden key overlap`);
  }

  return Object.freeze({
    workspace: requireString(
      source.workspace,
      `${field}.workspace`,
    ),
    text: requireString(source.text, `${field}.text`),
    scope: requireOneOf(
      source.scope,
      MEMORY_SCOPE_FILTERS,
      `${field}.scope`,
    ),
    access: requireOneOf(
      source.access,
      MEMORY_ACCESS_MODES,
      `${field}.access`,
    ),
    relevantKeys,
    forbiddenKeys,
  });
}

function parseAnswer(
  value: unknown,
  field: string,
): LongMemEvalAnswerRubric {
  const source = requireRecord(value, field);
  const requiredGroups = requireArray(
    source.requiredGroups,
    `${field}.requiredGroups`,
  ).map((group, index) =>
    requireStringArray(
      group,
      `${field}.requiredGroups[${index}]`,
      false,
    )
  );
  const abstain = requireBoolean(source.abstain, `${field}.abstain`);
  if (abstain && requiredGroups.length > 0) {
    invalid(`${field} cannot require facts and abstention together`);
  }
  if (!abstain && requiredGroups.length === 0) {
    invalid(`${field} must contain at least one required group`);
  }

  return Object.freeze({
    requiredGroups: Object.freeze(requiredGroups),
    forbiddenTerms: requireStringArray(
      source.forbiddenTerms,
      `${field}.forbiddenTerms`,
    ),
    abstain,
  });
}

function parseChecks(
  value: unknown,
  field: string,
  workspaces: readonly string[],
): LongMemEvalCaseChecks {
  const source = requireRecord(value, field);
  const update = source.update === undefined
    ? undefined
    : parseUpdateCheck(source.update, `${field}.update`, workspaces);
  const isolation = source.isolation === undefined
    ? undefined
    : parseIsolationCheck(source.isolation, `${field}.isolation`);
  const forbiddenPersistedTerms =
    source.forbiddenPersistedTerms === undefined
      ? undefined
      : requireStringArray(
          source.forbiddenPersistedTerms,
          `${field}.forbiddenPersistedTerms`,
        );
  if (
    update === undefined &&
    isolation === undefined &&
    forbiddenPersistedTerms === undefined
  ) {
    invalid(`${field} must define at least one check`);
  }
  return Object.freeze({
    ...(update === undefined ? {} : { update }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(forbiddenPersistedTerms === undefined
      ? {}
      : { forbiddenPersistedTerms }),
  });
}

function parseUpdateCheck(
  value: unknown,
  field: string,
  workspaces: readonly string[],
) {
  const source = requireRecord(value, field);
  const records = requireArray(source.records, `${field}.records`).map(
    (record, index) =>
      parseExpectedRecord(
        record,
        `${field}.records[${index}]`,
        workspaces,
      ),
  );
  if (records.length === 0) {
    invalid(`${field}.records must not be empty`);
  }
  return Object.freeze({
    records: Object.freeze(records),
    forbiddenPersistedTerms: requireStringArray(
      source.forbiddenPersistedTerms,
      `${field}.forbiddenPersistedTerms`,
    ),
  });
}

function parseExpectedRecord(
  value: unknown,
  field: string,
  workspaces: readonly string[],
): LongMemEvalExpectedRecord {
  const source = requireRecord(value, field);
  const workspace = requireString(
    source.workspace,
    `${field}.workspace`,
  );
  if (!workspaces.includes(workspace)) {
    invalid(`${field} references an unknown workspace`);
  }
  return Object.freeze({
    workspace,
    scope: requireOneOf(
      source.scope,
      MEMORY_SCOPES,
      `${field}.scope`,
    ),
    key: requireString(source.key, `${field}.key`),
    content: requireString(source.content, `${field}.content`),
    revision: requirePositiveInteger(
      source.revision,
      `${field}.revision`,
    ),
  });
}

function parseIsolationCheck(value: unknown, field: string) {
  const source = requireRecord(value, field);
  return Object.freeze({
    forbiddenContextTerms: requireStringArray(
      source.forbiddenContextTerms,
      `${field}.forbiddenContextTerms`,
    ),
    requireReadOnlyPolicy: requireBoolean(
      source.requireReadOnlyPolicy,
      `${field}.requireReadOnlyPolicy`,
    ),
  });
}

function parseMemoryReferences(
  value: unknown,
  field: string,
): readonly string[] {
  const references = requireStringArray(value, field);
  for (const reference of references) {
    if (!MEMORY_REFERENCE_PATTERN.test(reference)) {
      invalid(`${field} contains an invalid memory reference`, {
        reference,
      });
    }
  }
  assertUnique(references, field);
  return references;
}

function assertChronological(
  events: readonly LongMemEvalMemoryEvent[],
  field: string,
): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const timestamp = Date.parse(event.at);
    if (timestamp < previous) {
      invalid(`${field}.events must be chronological`);
    }
    previous = timestamp;
  }
}

function assertUnique(
  values: readonly string[],
  field: string,
): void {
  if (new Set(values).size !== values.length) {
    invalid(`${field} values must be unique`);
  }
}
