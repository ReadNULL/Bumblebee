import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  calculateCompositeScore,
  evaluateHardGates,
  type EvaluationTaskCounts,
  type ModelIdentity,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  BCS_COMPONENT_IDS,
  type BcsComponentId,
  type BcsGlobalMetricRule,
  type BcsScorecardResources,
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
import {
  BCS_PUBLICATION_CONTRACT_VERSION,
  type BcsEnvironmentRecoveryPublication,
  type BcsEnvironmentRecoveryResult,
  type BcsPublishedComponent,
  type PublishedRunEvidence,
  type PublishedStandardComponent,
  type PublishedTerminalBatch,
  type PublishedTerminalComponent,
  type PublishedTerminalSourceJob,
} from "./types.js";

const DEFAULT_PUBLICATION_PATH =
  "benchmark/benchmark_5_bcs_v1_scorecard/manifests/" +
  "bcs-v1-environment-recovery-2026-07-25.json";
const TERMINAL_MANIFEST_PATH =
  "benchmark/benchmark_2_terminal_bench_2_1/manifests/" +
  "terminal-bench-2-1-lite-v1.json";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export async function loadBcsEnvironmentRecoveryPublication(
  projectRoot: string,
  publicationPath = DEFAULT_PUBLICATION_PATH,
): Promise<BcsEnvironmentRecoveryPublication> {
  const [publication, terminalManifest] = await Promise.all([
    readJson(path.resolve(projectRoot, publicationPath)),
    readJson(path.resolve(projectRoot, TERMINAL_MANIFEST_PATH)),
  ]);
  return parseBcsEnvironmentRecoveryPublication(
    publication,
    readTerminalTaskIds(terminalManifest),
  );
}

export function parseBcsEnvironmentRecoveryPublication(
  value: unknown,
  expectedTerminalTaskIds: readonly string[],
): BcsEnvironmentRecoveryPublication {
  const source = requireRecord(value, "publication");
  if (
    source.contractVersion !== BCS_PUBLICATION_CONTRACT_VERSION
  ) {
    invalid("unsupported BCS publication contract version");
  }
  const id = requireString(source.id, "publication.id");
  const scoreSpec = requireString(
    source.scoreSpec,
    "publication.scoreSpec",
  );
  if (scoreSpec !== "bcs-v1") {
    invalid("publication must use the frozen BCS-v1 score spec");
  }
  const publicationMode = requireOneOf(
    source.publicationMode,
    ["environment-recovery-aggregate"],
    "publication.publicationMode",
  );
  const components = requireArray(
    source.components,
    "publication.components",
  ).map((component, index) =>
    parseComponent(component, index, expectedTerminalTaskIds)
  );
  assertComponentCoverage(components);
  assertPublicationIdentity(components);

  return Object.freeze({
    contractVersion: BCS_PUBLICATION_CONTRACT_VERSION,
    id,
    scoreSpec,
    publicationMode,
    reason: requireString(source.reason, "publication.reason"),
    components: Object.freeze(components),
  });
}

export function calculateBcsEnvironmentRecoveryPublication(
  resources: BcsScorecardResources,
  publication: BcsEnvironmentRecoveryPublication,
): BcsEnvironmentRecoveryResult {
  if (publication.scoreSpec !== resources.scoreSpec.id) {
    invalid("publication score spec does not match BCS resources");
  }
  const indexed = new Map(
    publication.components.map((component) => [
      component.id,
      component,
    ]),
  );
  assertSourceDefinitions(resources, indexed);
  const componentResults = BCS_COMPONENT_IDS.map((id) => {
    const component = indexed.get(id) as BcsPublishedComponent;
    return component.mode === "standard-run"
      ? Object.freeze({
          id,
          mode: component.mode,
          score: component.score,
          taskCounts: component.taskCounts,
        })
      : Object.freeze({
          id,
          mode: component.mode,
          score: calculateTerminalScore(component),
          taskCounts: terminalTaskCounts(component),
        });
  });
  const metrics = aggregateMetrics(
    resources.manifest.globalMetricRules,
    new Map(componentResults.map((item) => [item.id, item])),
    indexed,
  );
  const gateEvaluation = evaluateHardGates(
    resources.scoreSpec,
    metrics,
  );
  const score = calculateCompositeScore(
    resources.scoreSpec,
    Object.fromEntries(
      componentResults.map((component) => [
        component.id,
        component.score,
      ]),
    ),
    gateEvaluation,
  );

  return Object.freeze({
    publicationId: publication.id,
    publicationMode: publication.publicationMode,
    reason: publication.reason,
    metrics,
    gateEvaluation,
    score,
    components: Object.freeze(componentResults),
  });
}

function parseComponent(
  value: unknown,
  index: number,
  expectedTerminalTaskIds: readonly string[],
): BcsPublishedComponent {
  const field = `publication.components[${index}]`;
  const source = requireRecord(value, field);
  const id = requireOneOf(source.id, BCS_COMPONENT_IDS, `${field}.id`);
  const mode = requireOneOf(
    source.mode,
    ["standard-run", "environment-recovery-aggregate"],
    `${field}.mode`,
  );
  if (id === "TB") {
    if (mode !== "environment-recovery-aggregate") {
      invalid("TB publication must use environment recovery mode");
    }
    return parseTerminalComponent(
      source,
      field,
      expectedTerminalTaskIds,
    );
  }
  if (mode !== "standard-run") {
    invalid("only TB may use environment recovery mode", { id });
  }
  return parseStandardComponent(source, field, id);
}

function parseStandardComponent(
  source: Readonly<Record<string, unknown>>,
  field: string,
  id: Exclude<BcsComponentId, "TB">,
): PublishedStandardComponent {
  const score = requireFiniteNumber(source.score, `${field}.score`);
  if (score < 0 || score > 100) {
    invalid(`${field}.score must be between 0 and 100`);
  }
  return Object.freeze({
    id,
    mode: "standard-run",
    score,
    taskCounts: parseTaskCounts(
      source.taskCounts,
      `${field}.taskCounts`,
    ),
    metrics: requireMetricMap(source.metrics, `${field}.metrics`),
    evidence: parseRunEvidence(source.evidence, `${field}.evidence`),
  });
}

function parseRunEvidence(
  value: unknown,
  field: string,
): PublishedRunEvidence {
  const source = requireRecord(value, field);
  if (
    requireString(source.qualification, `${field}.qualification`) !==
      "qualified" ||
    requireBoolean(source.workspaceClean, `${field}.workspaceClean`) !==
      true
  ) {
    invalid(`${field} must reference a clean qualified run`);
  }
  const model = source.model === undefined
    ? undefined
    : parseModel(source.model, `${field}.model`);
  return Object.freeze({
    runId: requireString(source.runId, `${field}.runId`),
    suiteId: requireString(source.suiteId, `${field}.suiteId`),
    suiteVersion: requireString(
      source.suiteVersion,
      `${field}.suiteVersion`,
    ),
    qualification: "qualified",
    bumblebeeCommit: requireCommit(
      source.bumblebeeCommit,
      `${field}.bumblebeeCommit`,
    ),
    piVersion: requireString(source.piVersion, `${field}.piVersion`),
    workspaceClean: true,
    ...(model === undefined ? {} : { model }),
    manifestSha256: requireSha256(
      source.manifestSha256,
      `${field}.manifestSha256`,
    ),
    summarySha256: requireSha256(
      source.summarySha256,
      `${field}.summarySha256`,
    ),
  });
}

function parseTerminalComponent(
  source: Readonly<Record<string, unknown>>,
  field: string,
  expectedTaskIds: readonly string[],
): PublishedTerminalComponent {
  const sourceJobs = requireArray(
    source.sourceJobs,
    `${field}.sourceJobs`,
  ).map((job, index) =>
    parseTerminalSourceJob(job, `${field}.sourceJobs[${index}]`)
  );
  const jobs = new Map(sourceJobs.map((job) => [job.name, job]));
  if (jobs.size !== sourceJobs.length || sourceJobs.length < 2) {
    invalid("TB aggregate source jobs must be unique and plural");
  }
  const selectedBatches = requireArray(
    source.selectedBatches,
    `${field}.selectedBatches`,
  ).map((batch, index) =>
    parseTerminalBatch(
      batch,
      `${field}.selectedBatches[${index}]`,
      jobs,
    )
  );
  assertTerminalTaskCoverage(selectedBatches, expectedTaskIds);
  assertSelectedBatchesFitJobs(selectedBatches, jobs);
  const selectedCommits = new Set(
    selectedBatches.map(
      (batch) =>
        (jobs.get(batch.sourceJob) as PublishedTerminalSourceJob)
          .bumblebeeCommit,
    ),
  );
  if (selectedCommits.size < 2) {
    invalid("TB environment recovery aggregate must span multiple commits");
  }

  return Object.freeze({
    id: "TB",
    mode: "environment-recovery-aggregate",
    suiteId: requireString(source.suiteId, `${field}.suiteId`),
    suiteVersion: requireString(
      source.suiteVersion,
      `${field}.suiteVersion`,
    ),
    piVersion: requireString(source.piVersion, `${field}.piVersion`),
    model: parseModel(source.model, `${field}.model`),
    sourceJobs: Object.freeze(sourceJobs),
    selectedBatches: Object.freeze(selectedBatches),
  });
}

function parseTerminalSourceJob(
  value: unknown,
  field: string,
): PublishedTerminalSourceJob {
  const source = requireRecord(value, field);
  const completedTrials = requireInteger(
    source.completedTrials,
    `${field}.completedTrials`,
  );
  const passed = requireInteger(source.passed, `${field}.passed`);
  const failed = requireInteger(source.failed, `${field}.failed`);
  const invalidTrials = requireInteger(
    source.invalid,
    `${field}.invalid`,
  );
  if (passed + failed + invalidTrials !== completedTrials) {
    invalid(`${field} trial counts do not add up`);
  }
  return Object.freeze({
    name: requireString(source.name, `${field}.name`),
    harborJobId: requireString(
      source.harborJobId,
      `${field}.harborJobId`,
    ),
    bumblebeeCommit: requireCommit(
      source.bumblebeeCommit,
      `${field}.bumblebeeCommit`,
    ),
    completedTrials,
    passed,
    failed,
    invalid: invalidTrials,
    configSha256: requireSha256(
      source.configSha256,
      `${field}.configSha256`,
    ),
    resultSha256: requireSha256(
      source.resultSha256,
      `${field}.resultSha256`,
    ),
    trialResultsSha256: requireSha256(
      source.trialResultsSha256,
      `${field}.trialResultsSha256`,
    ),
  });
}

function parseTerminalBatch(
  value: unknown,
  field: string,
  sourceJobs: ReadonlyMap<string, PublishedTerminalSourceJob>,
): PublishedTerminalBatch {
  // A task batch is indivisible so the publication cannot cherry-pick trials.
  const source = requireRecord(value, field);
  const sourceJob = requireString(source.sourceJob, `${field}.sourceJob`);
  if (!sourceJobs.has(sourceJob)) {
    invalid(`${field}.sourceJob is not declared`);
  }
  const passed = requireInteger(source.passed, `${field}.passed`);
  const failed = requireInteger(source.failed, `${field}.failed`);
  const invalidTrials = requireInteger(
    source.invalid,
    `${field}.invalid`,
  );
  if (passed + failed + invalidTrials !== 5) {
    invalid(`${field} must contain exactly five trials`);
  }
  const invalidCategory = source.invalidCategory === undefined
    ? undefined
    : requireOneOf(
        source.invalidCategory,
        ["infrastructure"],
        `${field}.invalidCategory`,
      );
  const invalidReason = source.invalidReason === undefined
    ? undefined
    : requireString(source.invalidReason, `${field}.invalidReason`);
  if (
    (invalidTrials > 0 &&
      (invalidCategory === undefined || invalidReason === undefined)) ||
    (invalidTrials === 0 &&
      (invalidCategory !== undefined || invalidReason !== undefined))
  ) {
    invalid(
      `${field} must explain infrastructure invalid trials exactly when present`,
    );
  }
  return Object.freeze({
    taskId: requireString(source.taskId, `${field}.taskId`),
    sourceJob,
    passed,
    failed,
    invalid: invalidTrials,
    ...(invalidCategory === undefined ? {} : { invalidCategory }),
    ...(invalidReason === undefined ? {} : { invalidReason }),
  });
}

function parseTaskCounts(
  value: unknown,
  field: string,
): EvaluationTaskCounts {
  const source = requireRecord(value, field);
  const counts = {
    total: requireInteger(source.total, `${field}.total`),
    passed: requireInteger(source.passed, `${field}.passed`),
    failed: requireInteger(source.failed, `${field}.failed`),
    invalid: requireInteger(source.invalid, `${field}.invalid`),
    cancelled: requireInteger(source.cancelled, `${field}.cancelled`),
  };
  if (
    counts.passed +
      counts.failed +
      counts.invalid +
      counts.cancelled !==
    counts.total
  ) {
    invalid(`${field} counts do not add up`);
  }
  return Object.freeze(counts);
}

function parseModel(value: unknown, field: string): ModelIdentity {
  const source = requireRecord(value, field);
  const thinkingLevel = source.thinkingLevel === undefined
    ? undefined
    : requireString(source.thinkingLevel, `${field}.thinkingLevel`);
  return Object.freeze({
    provider: requireString(source.provider, `${field}.provider`),
    id: requireString(source.id, `${field}.id`),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });
}

function assertComponentCoverage(
  components: readonly BcsPublishedComponent[],
): void {
  if (
    components.length !== BCS_COMPONENT_IDS.length ||
    new Set(components.map((component) => component.id)).size !==
      BCS_COMPONENT_IDS.length ||
    !BCS_COMPONENT_IDS.every((id) =>
      components.some((component) => component.id === id)
    )
  ) {
    invalid("publication must define BB, TB, AD, and LM exactly once");
  }
}

function assertPublicationIdentity(
  components: readonly BcsPublishedComponent[],
): void {
  const standard = components.filter(
    (component): component is PublishedStandardComponent =>
      component.mode === "standard-run",
  );
  const terminal = components.find(
    (component): component is PublishedTerminalComponent =>
      component.id === "TB",
  ) as PublishedTerminalComponent;
  if (
    new Set(
      standard.map((component) => component.evidence.bumblebeeCommit),
    ).size !== 1
  ) {
    invalid("standard publication components must use one commit");
  }
  if (
    new Set([
      ...standard.map((component) => component.evidence.piVersion),
      terminal.piVersion,
    ]).size !== 1
  ) {
    invalid("publication components must use one Pi version");
  }
  const modelComponents = standard.filter(
    (component) => component.id === "AD" || component.id === "LM",
  );
  const models = [
    ...modelComponents.map((component) => component.evidence.model),
    terminal.model,
  ];
  if (
    models.some((model) => model === undefined) ||
    new Set((models as ModelIdentity[]).map(modelKey)).size !== 1
  ) {
    invalid("TB, AD, and LM publication models must match");
  }
}

function assertTerminalTaskCoverage(
  batches: readonly PublishedTerminalBatch[],
  expectedTaskIds: readonly string[],
): void {
  if (
    batches.length !== expectedTaskIds.length ||
    new Set(batches.map((batch) => batch.taskId)).size !==
      expectedTaskIds.length ||
    !expectedTaskIds.every((taskId) =>
      batches.some((batch) => batch.taskId === taskId)
    )
  ) {
    invalid("TB aggregate does not cover the frozen task set");
  }
}

function assertSelectedBatchesFitJobs(
  batches: readonly PublishedTerminalBatch[],
  jobs: ReadonlyMap<string, PublishedTerminalSourceJob>,
): void {
  for (const [name, job] of jobs) {
    const selected = batches.filter((batch) => batch.sourceJob === name);
    for (const field of ["passed", "failed", "invalid"] as const) {
      const count = selected.reduce(
        (sum, batch) => sum + batch[field],
        0,
      );
      if (count > job[field]) {
        invalid("TB selected batches contradict source job totals", {
          sourceJob: name,
          field,
        });
      }
    }
  }
}

function assertSourceDefinitions(
  resources: BcsScorecardResources,
  components: ReadonlyMap<BcsComponentId, BcsPublishedComponent>,
): void {
  for (const definition of resources.manifest.components) {
    const component = components.get(definition.id) as
      BcsPublishedComponent;
    if (component.mode === "standard-run") {
      if (
        component.evidence.suiteId !== definition.suiteId ||
        component.evidence.suiteVersion !== definition.suiteVersion
      ) {
        invalid("published standard run does not match BCS source", {
          component: definition.id,
        });
      }
      if (definition.id === "TB") {
        invalid("TB must use the environment recovery publication mode");
      }
      assertDerivedScore(definition.id, component);
    } else if (
      component.suiteId !== definition.suiteId ||
      component.suiteVersion !== definition.suiteVersion
    ) {
      invalid("published TB aggregate does not match BCS source");
    }
  }
}

function assertDerivedScore(
  id: Exclude<BcsComponentId, "TB">,
  component: PublishedStandardComponent,
): void {
  if (id !== "AD") {
    return;
  }
  const utility = component.metrics.utility_rate;
  const underAttack = component.metrics.utility_under_attack_rate;
  const security = component.metrics.security_rate;
  if (
    utility === undefined ||
    underAttack === undefined ||
    security === undefined
  ) {
    invalid("AD publication metrics are incomplete");
  }
  const derived = round(
    100 *
      Math.pow(utility, 0.25) *
      Math.pow(underAttack, 0.35) *
      Math.pow(security, 0.4),
  );
  if (derived !== component.score) {
    invalid("AD publication score does not match its metrics");
  }
}

function aggregateMetrics(
  rules: readonly BcsGlobalMetricRule[],
  results: ReadonlyMap<
    BcsComponentId,
    {
      readonly taskCounts: EvaluationTaskCounts;
    }
  >,
  components: ReadonlyMap<BcsComponentId, BcsPublishedComponent>,
): Readonly<Record<string, number>> {
  const metrics: Record<string, number> = {};
  for (const rule of rules) {
    if (rule.aggregation === "task-valid-rate") {
      const counts = rule.components.map(
        (id) => (results.get(id) as {
          readonly taskCounts: EvaluationTaskCounts;
        }).taskCounts,
      );
      const total = counts.reduce((sum, item) => sum + item.total, 0);
      const valid = counts.reduce(
        (sum, item) => sum + item.passed + item.failed,
        0,
      );
      metrics[rule.metric] = total === 0 ? 0 : round(valid / total);
      continue;
    }
    const values = rule.components.map((id) => {
      const component = components.get(id) as BcsPublishedComponent;
      return component.mode === "standard-run"
        ? component.metrics[rule.metric]
        : undefined;
    });
    if (values.some((value) => value === undefined)) {
      continue;
    }
    const complete = values as number[];
    metrics[rule.metric] = rule.aggregation === "value"
      ? complete[0] as number
      : round(complete.reduce((sum, value) => sum + value, 0));
  }
  return Object.freeze(metrics);
}

function terminalTaskCounts(
  component: PublishedTerminalComponent,
): EvaluationTaskCounts {
  const passed = sumBatches(component, "passed");
  const failed = sumBatches(component, "failed");
  const invalidTrials = sumBatches(component, "invalid");
  return Object.freeze({
    total: passed + failed + invalidTrials,
    passed,
    failed,
    invalid: invalidTrials,
    cancelled: 0,
  });
}

function calculateTerminalScore(
  component: PublishedTerminalComponent,
): number {
  // Infrastructure-invalid trials stay in the denominator and score zero.
  const counts = terminalTaskCounts(component);
  return round(100 * counts.passed / counts.total);
}

function sumBatches(
  component: PublishedTerminalComponent,
  field: "passed" | "failed" | "invalid",
): number {
  return component.selectedBatches.reduce(
    (sum, batch) => sum + batch[field],
    0,
  );
}

function readTerminalTaskIds(value: unknown): readonly string[] {
  const source = requireRecord(value, "Terminal-Bench manifest");
  const dataset = requireRecord(
    source.dataset,
    "Terminal-Bench manifest.dataset",
  );
  return Object.freeze(
    requireArray(
      dataset.selectedTasks,
      "Terminal-Bench manifest.dataset.selectedTasks",
    ).map((task, index) =>
      requireString(
        requireRecord(
          task,
          `Terminal-Bench manifest.dataset.selectedTasks[${index}]`,
        ).id,
        `Terminal-Bench manifest.dataset.selectedTasks[${index}].id`,
      )
    ),
  );
}

function requireCommit(value: unknown, field: string): string {
  const commit = requireString(value, field);
  if (!COMMIT_PATTERN.test(commit)) {
    invalid(`${field} must be a full Git commit`);
  }
  return commit;
}

function requireSha256(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!SHA256_PATTERN.test(hash)) {
    invalid(`${field} must be a lowercase SHA-256`);
  }
  return hash;
}

function modelKey(model: ModelIdentity): string {
  return JSON.stringify([
    model.provider,
    model.id,
    model.thinkingLevel ?? null,
  ]);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (cause: unknown) {
    invalid("could not read BCS publication input", {
      path: filePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
