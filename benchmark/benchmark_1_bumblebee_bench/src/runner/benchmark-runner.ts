import {
  EvaluationRunStore,
  type EnvironmentIdentity,
  type StartEvaluationRunInput,
  type SubjectIdentity,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  BUMBLEBEE_BENCH_CONTRACT_VERSION,
  type BumblebeeBenchManifest,
  type BumblebeeBenchProfile,
  type BumblebeeBenchReport,
  type ScenarioExecutionResult,
} from "../contracts/index.js";
import { getScenarioDefinitions } from "../scenarios/index.js";
import { aggregateBumblebeeBench } from "./aggregation.js";
import { executeScenario } from "./scenario-runner.js";

export interface RunBumblebeeBenchOptions {
  readonly manifest: BumblebeeBenchManifest;
  readonly profile: BumblebeeBenchProfile;
  readonly outputDirectory: string;
  readonly datasetHash: string;
  readonly subject: SubjectIdentity;
  readonly environment: EnvironmentIdentity;
  readonly typecheckPassRate: number;
  readonly parentRunId?: string;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
}

export async function runBumblebeeBench(
  options: RunBumblebeeBenchOptions,
): Promise<BumblebeeBenchReport> {
  const clock = options.clock ?? (() => new Date());
  const profile = options.manifest.profiles[options.profile];
  const definitions = getScenarioDefinitions(options.manifest);
  const scenarioConfigs = new Map(
    options.manifest.domains.flatMap((domain) =>
      domain.scenarios.map((scenario) => [scenario.id, scenario] as const),
    ),
  );
  const store = new EvaluationRunStore({
    outputDirectory: options.outputDirectory,
    clock,
  });
  const run = await store.startRun(createRunManifestInput(
    options,
    profile.repetitions,
  ));
  const results: ScenarioExecutionResult[] = [];

  for (const definition of definitions) {
    const config = scenarioConfigs.get(definition.id);
    if (config === undefined) {
      throw new Error(
        `Scenario ${definition.id} has no manifest configuration`,
      );
    }

    for (let trial = 1; trial <= profile.repetitions; trial += 1) {
      const result = await executeScenario(
        definition,
        config,
        trial,
        {
          clock,
          ...(options.signal === undefined
            ? {}
            : { signal: options.signal }),
        },
      );
      const evidence = await run.recordJsonArtifact({
        relativePath:
          `scenarios/${definition.id}/trial-${trial}.json`,
        kind: "verifier",
        mediaType: "application/json",
        value: result,
      });
      await run.recordTask({
        taskId: definition.id,
        trial,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        reward: result.reward,
        metrics: {
          ...result.metrics,
          correctness: result.correctness,
          slo_compliance: result.sloCompliance,
        },
        ...(result.failure === undefined
          ? {}
          : { failure: result.failure }),
        artifacts: [evidence],
        metadata: {
          domain: definition.domain,
          profile: options.profile,
        },
      });
      results.push(result);
    }
  }

  const aggregation = aggregateBumblebeeBench(
    options.manifest,
    results,
    profile.repetitions,
    { typecheckPassRate: options.typecheckPassRate },
  );
  const report: BumblebeeBenchReport = Object.freeze({
    contractVersion: BUMBLEBEE_BENCH_CONTRACT_VERSION,
    runId: run.manifest.runId,
    manifestId: options.manifest.id,
    manifestVersion: options.manifest.version,
    profile: options.profile,
    generatedAt: clock().toISOString(),
    scenarioResults: Object.freeze([...results]),
    domains: aggregation.domains,
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    score: aggregation.score,
  });
  await run.recordJsonArtifact({
    relativePath: "report.json",
    kind: "report",
    mediaType: "application/json",
    value: report,
  });

  const hasInvalidTask = results.some(
    (result) => result.status === "invalid",
  );
  const hasCancelledTask = results.some(
    (result) => result.status === "cancelled",
  );
  await run.finalize({
    status: hasInvalidTask
      ? "invalid"
      : hasCancelledTask
        ? "cancelled"
        : "completed",
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    compositeScore: aggregation.score,
    ...(hasInvalidTask
      ? {
          failure: {
            category: "infrastructure" as const,
            code: "INVALID_BENCHMARK_TASK",
            message: "At least one benchmark task was invalid",
            retryable: true,
          },
        }
      : hasCancelledTask
        ? {
            failure: {
              category: "infrastructure" as const,
              code: "BENCHMARK_CANCELLED",
              message: "Benchmark execution was cancelled",
            },
          }
        : {}),
  });

  return report;
}

function createRunManifestInput(
  options: RunBumblebeeBenchOptions,
  repetitions: number,
): StartEvaluationRunInput {
  const totalTimeoutMs = options.manifest.domains.reduce(
    (total, domain) =>
      total + domain.scenarios.reduce(
        (domainTotal, scenario) =>
          domainTotal + scenario.timeoutMs * repetitions,
        0,
      ),
    0,
  );

  return {
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    scoreSpec: options.manifest.scoreSpec.id,
    suite: {
      id: options.manifest.id,
      name: "BumblebeeBench",
      version: options.manifest.version,
      split: "dev",
      datasetHash: options.datasetHash,
    },
    subject: options.subject,
    environment: options.environment,
    budget: {
      timeoutMs: totalTimeoutMs,
      concurrency: 1,
    },
    repetitions,
    metadata: {
      profile: options.profile,
      scenarioCount: options.manifest.domains.reduce(
        (total, domain) => total + domain.scenarios.length,
        0,
      ),
    },
  };
}
