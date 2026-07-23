import {
  assertIdentifier,
  assertScoreSpec,
  type ScoreSpec,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION,
  LONGMEMEVAL_CAPABILITIES,
  type LongMemEvalManifest,
  type LongMemEvalProfile,
} from "./types.js";
import {
  invalid,
  requireArray,
  requireBoolean,
  requireOneOf,
  requirePositiveInteger,
  requireRecord,
  requireSha256,
  requireString,
} from "./validation.js";

const EXPECTED_COMPONENT_WEIGHTS = new Map([
  ["QAAccuracy", 0.35],
  ["RecallAt5", 0.2],
  ["PrecisionAt5", 0.1],
  ["UpdateAccuracy", 0.15],
  ["AbstentionF1", 0.1],
  ["IsolationAccuracy", 0.1],
] as const);

type ExpectedGate = readonly [
  "validity" | "qualification",
  string,
  "eq" | "gte" | "lte",
  number,
];

const EXPECTED_HARD_GATES = new Map<string, ExpectedGate>([
  ["dataset_identity", ["validity", "dataset_identity_match", "eq", 1]],
  ["dataset_hash", ["validity", "dataset_hash_match", "eq", 1]],
  ["dataset_cases", ["validity", "dataset_case_count", "eq", 12]],
  [
    "capability_coverage",
    ["validity", "capability_coverage_rate", "eq", 1],
  ],
  ["pi_version", ["validity", "pi_version_match", "eq", 1]],
  ["adapter_errors", ["validity", "adapter_error_count", "eq", 0]],
  ["valid_tasks", ["validity", "valid_task_rate", "gte", 0.98]],
  ["formal_profile", ["qualification", "formal_profile_match", "eq", 1]],
  [
    "answer_coverage",
    ["qualification", "answer_coverage_rate", "eq", 1],
  ],
  [
    "candidate_commit",
    ["qualification", "candidate_commit_pinned", "eq", 1],
  ],
  ["clean_workspace", ["qualification", "workspace_clean", "eq", 1]],
  [
    "memory_scope",
    ["qualification", "memory_scope_leak_count", "eq", 0],
  ],
  [
    "secret_persistence",
    ["qualification", "secret_persisted_count", "eq", 0],
  ],
]);

export function parseLongMemEvalManifest(
  value: unknown,
): LongMemEvalManifest {
  const source = requireRecord(value, "manifest");
  if (
    source.contractVersion !==
      LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION
  ) {
    invalid("unsupported LongMemEval-Bumblebee manifest version");
  }
  const id = requireString(source.id, "manifest.id");
  const version = requireString(source.version, "manifest.version");
  assertIdentifier(id, "manifest.id");
  assertIdentifier(version, "manifest.version");

  const dataset = requireRecord(source.dataset, "manifest.dataset");
  const reader = requireRecord(source.reader, "manifest.reader");
  const aggregation = requireRecord(
    source.aggregation,
    "manifest.aggregation",
  );
  const scoreSpec = requireRecord(
    source.scoreSpec,
    "manifest.scoreSpec",
  ) as unknown as ScoreSpec;
  assertScoreSpec(scoreSpec);
  if (scoreSpec.id !== id) {
    invalid("manifest score spec id must match manifest id");
  }
  assertFrozenScoreSpec(scoreSpec);

  const capabilities = requireArray(
    dataset.capabilities,
    "manifest.dataset.capabilities",
  ).map((item, index) =>
    requireOneOf(
      item,
      LONGMEMEVAL_CAPABILITIES,
      `manifest.dataset.capabilities[${index}]`,
    )
  );
  if (
    capabilities.length !== LONGMEMEVAL_CAPABILITIES.length ||
    LONGMEMEVAL_CAPABILITIES.some(
      (capability) => !capabilities.includes(capability),
    )
  ) {
    invalid("manifest must freeze every LongMemEval capability");
  }

  const profiles = requireRecord(
    source.profiles,
    "manifest.profiles",
  );

  return Object.freeze({
    contractVersion: LONGMEMEVAL_BUMBLEBEE_CONTRACT_VERSION,
    id,
    version,
    description: requireString(
      source.description,
      "manifest.description",
    ),
    dataset: Object.freeze({
      file: requireFrozenString(
        dataset.file,
        "manifest.dataset.file",
        "datasets/longmemeval-bumblebee-v1.json",
      ),
      sha256: requireSha256(
        dataset.sha256,
        "manifest.dataset.sha256",
      ),
      caseCount: requireFrozenNumber(
        dataset.caseCount,
        "manifest.dataset.caseCount",
        12,
      ),
      capabilities: Object.freeze(capabilities),
      reference: requireString(
        dataset.reference,
        "manifest.dataset.reference",
      ),
      derivation: requireFrozenString(
        dataset.derivation,
        "manifest.dataset.derivation",
        "project-authored",
      ),
    }),
    profiles: Object.freeze({
      "memory-core": parseProfile(
        profiles["memory-core"],
        "memory-core",
        "none",
        1,
        false,
      ),
      "bumblebee-full": parseProfile(
        profiles["bumblebee-full"],
        "bumblebee-full",
        "pi",
        3,
        true,
      ),
    }),
    reader: Object.freeze({
      piPackage: requireFrozenString(
        reader.piPackage,
        "manifest.reader.piPackage",
        "@earendil-works/pi-coding-agent",
      ),
      piVersion: requireString(
        reader.piVersion,
        "manifest.reader.piVersion",
      ),
      taskTimeoutMs: requirePositiveInteger(
        reader.taskTimeoutMs,
        "manifest.reader.taskTimeoutMs",
      ),
      systemPrompt: requireString(
        reader.systemPrompt,
        "manifest.reader.systemPrompt",
      ),
    }),
    aggregation: Object.freeze({
      qaAccuracy: requireFrozenString(
        aggregation.qaAccuracy,
        "manifest.aggregation.qaAccuracy",
        "capability-macro",
      ),
      recallAt5: requireFrozenString(
        aggregation.recallAt5,
        "manifest.aggregation.recallAt5",
        "applicable-capability-macro",
      ),
      precisionAt5: requireFrozenString(
        aggregation.precisionAt5,
        "manifest.aggregation.precisionAt5",
        "applicable-capability-macro",
      ),
      updateAccuracy: requireFrozenString(
        aggregation.updateAccuracy,
        "manifest.aggregation.updateAccuracy",
        "applicable-capability-macro",
      ),
      abstentionF1: requireFrozenString(
        aggregation.abstentionF1,
        "manifest.aggregation.abstentionF1",
        "global-binary-f1",
      ),
      isolationAccuracy: requireFrozenString(
        aggregation.isolationAccuracy,
        "manifest.aggregation.isolationAccuracy",
        "applicable-capability-macro",
      ),
    }),
    scoreSpec,
  });
}

function parseProfile(
  value: unknown,
  profile: LongMemEvalProfile,
  expectedReader: "none" | "pi",
  expectedRepetitions: number,
  expectedFormal: boolean,
) {
  const field = `manifest.profiles.${profile}`;
  const source = requireRecord(value, field);
  return Object.freeze({
    reader: requireFrozenString(
      source.reader,
      `${field}.reader`,
      expectedReader,
    ),
    repetitions: requireFrozenNumber(
      source.repetitions,
      `${field}.repetitions`,
      expectedRepetitions,
    ),
    formal: requireFrozenBoolean(
      source.formal,
      `${field}.formal`,
      expectedFormal,
    ),
  });
}

function assertFrozenScoreSpec(scoreSpec: ScoreSpec): void {
  if (
    scoreSpec.components.length !==
      EXPECTED_COMPONENT_WEIGHTS.size
  ) {
    invalid("LongMemEval score spec has unexpected components");
  }
  const seenComponents = new Set<string>();
  for (const component of scoreSpec.components) {
    const expected = EXPECTED_COMPONENT_WEIGHTS.get(
      component.id as LongMemEvalComponentId,
    );
    if (
      expected === undefined ||
      expected !== component.weight ||
      seenComponents.has(component.id)
    ) {
      invalid("LongMemEval score component is not frozen", {
        componentId: component.id,
      });
    }
    seenComponents.add(component.id);
  }

  if (scoreSpec.hardGates.length !== EXPECTED_HARD_GATES.size) {
    invalid("LongMemEval score spec has unexpected hard gates");
  }
  const seenGates = new Set<string>();
  for (const gate of scoreSpec.hardGates) {
    const expected = EXPECTED_HARD_GATES.get(gate.id);
    if (
      expected === undefined ||
      seenGates.has(gate.id) ||
      gate.kind !== expected[0] ||
      gate.metric !== expected[1] ||
      gate.operator !== expected[2] ||
      gate.threshold !== expected[3]
    ) {
      invalid("LongMemEval hard gate is not frozen", {
        gateId: gate.id,
      });
    }
    seenGates.add(gate.id);
  }
}

function requireFrozenString<const T extends string>(
  value: unknown,
  field: string,
  expected: T,
): T {
  const actual = requireString(value, field);
  if (actual !== expected) {
    invalid(`${field} does not match the frozen contract`);
  }
  return expected;
}

function requireFrozenNumber<const T extends number>(
  value: unknown,
  field: string,
  expected: T,
): T {
  const actual = requirePositiveInteger(value, field);
  if (actual !== expected) {
    invalid(`${field} does not match the frozen contract`);
  }
  return expected;
}

function requireFrozenBoolean<const T extends boolean>(
  value: unknown,
  field: string,
  expected: T,
): T {
  const actual = requireBoolean(value, field);
  if (actual !== expected) {
    invalid(`${field} does not match the frozen contract`);
  }
  return expected;
}

type LongMemEvalComponentId =
  | "QAAccuracy"
  | "RecallAt5"
  | "PrecisionAt5"
  | "UpdateAccuracy"
  | "AbstentionF1"
  | "IsolationAccuracy";
