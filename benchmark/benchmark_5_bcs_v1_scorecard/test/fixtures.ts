import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  EVALUATION_CONTRACT_VERSION,
  EvaluationRunStore,
  type CompositeScore,
  type EvaluationRunStatus,
  type GateEvaluation,
  type ModelIdentity,
  type QualificationStatus,
} from "../../benchmark_0_evaluation_core/src/index.js";
import {
  type BcsComponentId,
  type BcsScorecardResources,
  type BcsSourceDefinition,
} from "../src/index.js";

export const benchmarkRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const projectRoot = path.resolve(benchmarkRoot, "../..");
export const fixedCommit = "a".repeat(40);
export const fixedModel: ModelIdentity = Object.freeze({
  provider: "test-provider",
  id: "test-model",
  thinkingLevel: "medium",
});

export interface CreateSourceRunOptions {
  readonly component: BcsComponentId;
  readonly rootDirectory: string;
  readonly resources: BcsScorecardResources;
  readonly score?: number;
  readonly qualification?: QualificationStatus;
  readonly status?: EvaluationRunStatus;
  readonly commit?: string;
  readonly piVersion?: string;
  readonly workspaceClean?: boolean;
  readonly model?: ModelIdentity;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly metadata?: Readonly<Record<string, string>>;
}

export async function createSourceRun(
  options: CreateSourceRunOptions,
): Promise<string> {
  const definition = definitionFor(
    options.resources,
    options.component,
  );
  const qualification = options.qualification ?? "qualified";
  const status = options.status ??
    (qualification === "invalid" ? "invalid" : "completed");
  const outputDirectory = path.join(
    options.rootDirectory,
    options.component.toLowerCase(),
  );
  const runId = `run_${options.component.toLowerCase()}`;
  const clock = () => new Date("2026-07-23T10:00:00.000Z");
  const store = new EvaluationRunStore({
    outputDirectory,
    clock,
    runIdFactory: () => runId,
  });
  const model = options.component === "BB"
    ? undefined
    : options.model ?? fixedModel;
  const run = await store.startRun({
    scoreSpec: definition.scoreSpec,
    suite: {
      id: definition.suiteId,
      name: definition.suiteId,
      version: definition.suiteVersion,
      split: definition.suiteSplit,
      datasetHash: componentHash(options.component),
    },
    subject: {
      bumblebeeCommit: options.commit ?? fixedCommit,
      workspaceClean: options.workspaceClean ?? true,
      piVersion: options.piVersion ?? "0.78.1",
    },
    environment: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hardwareProfile: `${options.component.toLowerCase()}-fixture`,
    },
    ...(model === undefined ? {} : { model }),
    budget: {
      timeoutMs: 1_000,
      concurrency: 1,
    },
    repetitions: 1,
    metadata: {
      ...definition.requiredMetadata,
      ...options.metadata,
    },
  });
  await run.recordTask({
    taskId: `${options.component.toLowerCase()}-task`,
    trial: 1,
    status: "passed",
    startedAt: clock().toISOString(),
    finishedAt: clock().toISOString(),
    durationMs: 0,
  });
  const gateEvaluation = createGateEvaluation(
    definition.scoreSpec,
    qualification,
  );
  const metrics = {
    ...defaultMetrics(options.component),
    ...options.metrics,
  };
  const compositeScore = options.component === "AD"
    ? undefined
    : createCompositeScore(
        definition.scoreSpec,
        qualification,
        options.score ?? defaultScore(options.component),
      );
  await run.finalize({
    status,
    metrics,
    gateEvaluation,
    ...(compositeScore === undefined ? {} : { compositeScore }),
    ...(status === "invalid"
      ? {
          failure: {
            category: "infrastructure" as const,
            code: "FIXTURE_INVALID",
            message: "Fixture run is invalid",
          },
        }
      : {}),
  });

  return path.join(outputDirectory, "artifacts", runId);
}

export async function createAllSourceRuns(
  rootDirectory: string,
  resources: BcsScorecardResources,
): Promise<Readonly<Record<BcsComponentId, string>>> {
  const entries = await Promise.all(
    (["BB", "TB", "AD", "LM"] as const).map(
      async (component) => [
        component,
        await createSourceRun({
          component,
          rootDirectory,
          resources,
        }),
      ] as const,
    ),
  );
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<BcsComponentId, string>
  >;
}

function definitionFor(
  resources: BcsScorecardResources,
  component: BcsComponentId,
): BcsSourceDefinition {
  const definition = resources.manifest.components.find(
    (candidate) => candidate.id === component,
  );
  if (definition === undefined) {
    throw new Error(`Missing fixture definition: ${component}`);
  }
  return definition;
}

function createGateEvaluation(
  scoreSpec: string,
  qualification: QualificationStatus,
): GateEvaluation {
  if (qualification === "qualified") {
    return Object.freeze({
      contractVersion: EVALUATION_CONTRACT_VERSION,
      scoreSpec,
      status: qualification,
      decisions: Object.freeze([]),
    });
  }
  const kind = qualification === "invalid"
    ? "validity"
    : "qualification";
  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec,
    status: qualification,
    decisions: Object.freeze([
      Object.freeze({
        gateId: "fixture_gate",
        kind,
        metric: "fixture_metric",
        operator: "eq",
        threshold: 1,
        actual: 0,
        status: "failed",
      }),
    ]),
  });
}

function createCompositeScore(
  scoreSpec: string,
  qualification: QualificationStatus,
  score: number,
): CompositeScore {
  return Object.freeze({
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec,
    qualification,
    score: qualification === "qualified" ? score : null,
    components: Object.freeze([]),
  });
}

function defaultMetrics(
  component: BcsComponentId,
): Readonly<Record<string, number>> {
  switch (component) {
    case "BB":
      return {
        typecheck_pass_rate: 1,
        deterministic_test_pass_rate: 1,
        critical_unsafe_action_count: 0,
        workspace_escape_count: 0,
        remote_write_success_count: 0,
        memory_scope_leak_count: 0,
        unauthorized_channel_accept_count: 0,
        session_order_violation_count: 0,
        duplicate_side_effect_count: 0,
        secret_persisted_count: 0,
      };
    case "AD":
      return {
        utility_rate: 0.81,
        utility_under_attack_rate: 0.64,
        security_rate: 0.49,
      };
    case "LM":
      return {
        critical_unsafe_action_count: 0,
        memory_scope_leak_count: 0,
        secret_persisted_count: 0,
      };
    case "TB":
      return {};
  }
}

function defaultScore(component: BcsComponentId): number {
  switch (component) {
    case "BB":
      return 90;
    case "TB":
      return 80;
    case "AD":
      return 0;
    case "LM":
      return 70;
  }
}

function componentHash(component: BcsComponentId): string {
  const value = {
    BB: "1",
    TB: "2",
    AD: "3",
    LM: "4",
  }[component];
  return value.repeat(64);
}
