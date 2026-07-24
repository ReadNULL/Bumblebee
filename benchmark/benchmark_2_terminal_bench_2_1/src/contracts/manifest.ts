import {
  assertIdentifier,
  assertScoreSpec,
  type ScoreSpec,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  TERMINAL_BENCH_COMPONENTS,
  TERMINAL_BENCH_CONTRACT_VERSION,
  type TerminalBenchManifest,
  type TerminalBenchSelectedTask,
  type TerminalBenchTaskDifficulty,
} from "./types.js";
import {
  invalid,
  requireArray,
  requireNumber,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./validation.js";

const EXPECTED_COMPONENT_WEIGHTS = new Map([
  ["OfficialReward", 0.8],
  ["CostEfficiency", 0.1],
  ["LatencyEfficiency", 0.05],
  ["Stability", 0.05],
] as const);

export function parseTerminalBenchManifest(
  value: unknown,
): TerminalBenchManifest {
  const source = requireRecord(value, "manifest");
  if (
    source.contractVersion !== TERMINAL_BENCH_CONTRACT_VERSION
  ) {
    invalid("unsupported Terminal-Bench contract version");
  }

  const id = requireString(source.id, "manifest.id");
  const version = requireString(source.version, "manifest.version");
  assertIdentifier(id, "manifest.id");
  assertIdentifier(version, "manifest.version");

  const datasetSource = requireRecord(
    source.dataset,
    "manifest.dataset",
  );
  const pinning = requireString(
    datasetSource.pinning,
    "manifest.dataset.pinning",
  );
  if (pinning !== "resolved-task-checksums") {
    invalid(
      "Terminal-Bench dataset must be pinned by resolved task checksums",
    );
  }
  const sourceTaskCount = requirePositiveInteger(
    datasetSource.sourceTaskCount,
    "manifest.dataset.sourceTaskCount",
  );
  const samplingFraction = requireNumber(
    datasetSource.samplingFraction,
    "manifest.dataset.samplingFraction",
  );
  if (samplingFraction !== 0.1) {
    invalid("Terminal-Bench Lite sampling fraction must be 0.1");
  }
  const selectionMethod = requireString(
    datasetSource.selectionMethod,
    "manifest.dataset.selectionMethod",
  );
  if (selectionMethod !== "frozen-stratified-subset") {
    invalid(
      "Terminal-Bench Lite must use a frozen stratified subset",
    );
  }
  const expectedTaskCount = requirePositiveInteger(
    datasetSource.expectedTaskCount,
    "manifest.dataset.expectedTaskCount",
  );
  const selectedTasks = parseSelectedTasks(
    datasetSource.selectedTasks,
  );
  if (
    expectedTaskCount !==
      Math.ceil(sourceTaskCount * samplingFraction) ||
    selectedTasks.length !== expectedTaskCount
  ) {
    invalid(
      "Terminal-Bench Lite task count does not match its frozen sample",
      {
        expectedTaskCount,
        selectedTaskCount: selectedTasks.length,
        sourceTaskCount,
      },
    );
  }

  const agentsSource = requireRecord(
    source.agents,
    "manifest.agents",
  );
  const baselineSource = requireRecord(
    source.baseline,
    "manifest.baseline",
  );
  const estimator = requireString(
    baselineSource.estimator,
    "manifest.baseline.estimator",
  );
  if (estimator !== "median") {
    invalid("only the median baseline estimator is supported");
  }

  const scoreSpec = requireRecord(
    source.scoreSpec,
    "manifest.scoreSpec",
  ) as unknown as ScoreSpec;
  assertScoreSpec(scoreSpec);
  if (scoreSpec.id !== id) {
    invalid("score spec id must match manifest id");
  }
  assertScoreComponents(scoreSpec);

  return Object.freeze({
    contractVersion: TERMINAL_BENCH_CONTRACT_VERSION,
    id,
    version,
    description: requireString(
      source.description,
      "manifest.description",
    ),
    dataset: Object.freeze({
      id: requireString(
        datasetSource.id,
        "manifest.dataset.id",
      ),
      reference: requireString(
        datasetSource.reference,
        "manifest.dataset.reference",
      ),
      pinning,
      sourceTaskCount,
      samplingFraction,
      selectionMethod,
      expectedTaskCount,
      minimumTrialsPerTask: requirePositiveInteger(
        datasetSource.minimumTrialsPerTask,
        "manifest.dataset.minimumTrialsPerTask",
      ),
      selectedTasks: Object.freeze(selectedTasks),
    }),
    agents: Object.freeze({
      baseline: requireFrozenString(
        agentsSource.baseline,
        "manifest.agents.baseline",
        "pi-baseline",
      ),
      candidate: requireFrozenString(
        agentsSource.candidate,
        "manifest.agents.candidate",
        "bumblebee-pi",
      ),
      piPackage: requireFrozenString(
        agentsSource.piPackage,
        "manifest.agents.piPackage",
        "@earendil-works/pi-coding-agent",
      ),
      piVersion: requireFrozenString(
        agentsSource.piVersion,
        "manifest.agents.piVersion",
        "0.78.1",
      ),
      extensionSourcePrefix: requireFrozenString(
        agentsSource.extensionSourcePrefix,
        "manifest.agents.extensionSourcePrefix",
        "git:github.com/ReadNULL/Bumblebee@",
      ),
    }),
    baseline: Object.freeze({
      requiredRuns: requirePositiveInteger(
        baselineSource.requiredRuns,
        "manifest.baseline.requiredRuns",
      ),
      minimumSamplesPerTask: requirePositiveInteger(
        baselineSource.minimumSamplesPerTask,
        "manifest.baseline.minimumSamplesPerTask",
      ),
      estimator,
    }),
    rewardKey: requireString(
      source.rewardKey,
      "manifest.rewardKey",
    ),
    scoreSpec,
  });
}

function parseSelectedTasks(
  value: unknown,
): TerminalBenchSelectedTask[] {
  const tasks = requireArray(
    value,
    "manifest.dataset.selectedTasks",
  ).map((item, index) => {
    const field = `manifest.dataset.selectedTasks[${index}]`;
    const source = requireRecord(item, field);
    const difficulty = requireString(
      source.difficulty,
      `${field}.difficulty`,
    );
    if (!isTaskDifficulty(difficulty)) {
      invalid(`${field}.difficulty is not supported`, {
        difficulty,
      });
    }
    return Object.freeze({
      id: requireString(source.id, `${field}.id`),
      category: requireString(
        source.category,
        `${field}.category`,
      ),
      difficulty,
      capability: requireString(
        source.capability,
        `${field}.capability`,
      ),
    });
  });
  const taskIds = new Set(tasks.map((task) => task.id));
  if (taskIds.size !== tasks.length) {
    invalid("Terminal-Bench Lite selected task ids must be unique");
  }
  return tasks;
}

function isTaskDifficulty(
  value: string,
): value is TerminalBenchTaskDifficulty {
  return value === "easy" || value === "medium" || value === "hard";
}

function requireFrozenString(
  value: unknown,
  field: string,
  expected: string,
): string {
  const actual = requireString(value, field);
  if (actual !== expected) {
    invalid(`${field} does not match the frozen adapter`, {
      actual,
      expected,
    });
  }
  return actual;
}

function assertScoreComponents(scoreSpec: ScoreSpec): void {
  if (
    scoreSpec.components.length !==
      TERMINAL_BENCH_COMPONENTS.length
  ) {
    invalid("Terminal-Bench score spec has unexpected components");
  }

  const seen = new Set<string>();
  for (const component of scoreSpec.components) {
    const expectedWeight = EXPECTED_COMPONENT_WEIGHTS.get(
      component.id as
        | "OfficialReward"
        | "CostEfficiency"
        | "LatencyEfficiency"
        | "Stability",
    );
    if (
      expectedWeight === undefined ||
      component.weight !== expectedWeight ||
      seen.has(component.id)
    ) {
      invalid("Terminal-Bench score component is not frozen", {
        componentId: component.id,
        weight: requireNumber(
          component.weight,
          `scoreSpec.components.${component.id}.weight`,
        ),
      });
    }
    seen.add(component.id);
  }
}
