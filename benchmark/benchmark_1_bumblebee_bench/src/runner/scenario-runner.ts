import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ERROR_CODES,
  normalizeError,
  withTimeout,
} from "../../../../src/foundation/index.js";
import {
  BUMBLEBEE_BENCH_CONTRACT_VERSION,
  type BumblebeeBenchScenarioConfig,
  type ScenarioExecutionResult,
  type ScenarioObservation,
} from "../contracts/index.js";
import {
  ScenarioProbe,
  type ScenarioDefinition,
} from "./scenario.js";

export interface ExecuteScenarioOptions {
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
  readonly temporaryRoot?: string;
}

/** 执行一个隔离场景，并把任何结果归一化为可持久化 task result。 */
export async function executeScenario(
  definition: ScenarioDefinition,
  config: BumblebeeBenchScenarioConfig,
  trial: number,
  options: ExecuteScenarioOptions = {},
): Promise<ScenarioExecutionResult> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  let fixtureDirectory: string;

  try {
    fixtureDirectory = await mkdtemp(
      join(options.temporaryRoot ?? tmpdir(), "bumblebee-bench-"),
    );
  } catch (cause: unknown) {
    return createInfrastructureFailure(
      definition,
      trial,
      config,
      startedAt,
      clock().toISOString(),
      0,
      "FIXTURE_SETUP_FAILED",
      cause,
    );
  }

  const probe = new ScenarioProbe();
  const started = performance.now();
  let observation: ScenarioObservation | undefined;
  let executionFailure: unknown;

  try {
    await withTimeout(
      async (signal) => {
        await definition.run(
          { fixtureDirectory, signal },
          probe,
        );
      },
      {
        operationName: definition.id,
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal }),
        timeoutMs: config.timeoutMs,
      },
    );
    observation = probe.snapshot();
  } catch (cause: unknown) {
    executionFailure = cause;
  }

  const durationMs = roundMilliseconds(performance.now() - started);
  let cleanupFailure: unknown;
  try {
    await rm(fixtureDirectory, { recursive: true, force: true });
  } catch (cause: unknown) {
    cleanupFailure = cause;
  }
  const finishedAt = clock().toISOString();

  if (cleanupFailure !== undefined) {
    return createInfrastructureFailure(
      definition,
      trial,
      config,
      startedAt,
      finishedAt,
      durationMs,
      "FIXTURE_CLEANUP_FAILED",
      cleanupFailure,
    );
  }

  if (executionFailure !== undefined) {
    return createExecutionFailure(
      definition,
      trial,
      config,
      startedAt,
      finishedAt,
      durationMs,
      executionFailure,
    );
  }

  return createObservedResult(
    definition,
    trial,
    config,
    startedAt,
    finishedAt,
    durationMs,
    observation as ScenarioObservation,
  );
}

function createObservedResult(
  definition: ScenarioDefinition,
  trial: number,
  config: BumblebeeBenchScenarioConfig,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  observation: ScenarioObservation,
): ScenarioExecutionResult {
  const passedCount = observation.assertions.filter(
    (assertion) => assertion.passed,
  ).length;
  const correctness = passedCount / observation.assertions.length;
  const sloCompliance = calculateSloCompliance(
    durationMs,
    config.sloMs,
  );
  const reward = roundScore(
    0.8 * correctness + 0.2 * sloCompliance,
  );
  const status = correctness === 1 ? "passed" : "failed";
  const failedCount = observation.assertions.length - passedCount;

  return Object.freeze({
    contractVersion: BUMBLEBEE_BENCH_CONTRACT_VERSION,
    scenarioId: definition.id,
    domain: definition.domain,
    trial,
    status,
    startedAt,
    finishedAt,
    durationMs,
    correctness: roundScore(correctness),
    sloCompliance,
    reward,
    assertions: observation.assertions,
    metrics: Object.freeze({
      ...observation.metrics,
      assertion_count: observation.assertions.length,
      assertion_failure_count: failedCount,
    }),
    ...(status === "passed"
      ? {}
      : {
          failure: {
            category: "bumblebee" as const,
            code: "ASSERTION_FAILED",
            message:
              `${failedCount} assertion(s) failed in ${definition.id}`,
          },
        }),
  });
}

function createExecutionFailure(
  definition: ScenarioDefinition,
  trial: number,
  config: BumblebeeBenchScenarioConfig,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  cause: unknown,
): ScenarioExecutionResult {
  const normalized = normalizeError(cause);
  const cancelled = normalized.code === ERROR_CODES.CANCELLED;
  const timedOut = normalized.code === ERROR_CODES.TIMEOUT;

  return Object.freeze({
    contractVersion: BUMBLEBEE_BENCH_CONTRACT_VERSION,
    scenarioId: definition.id,
    domain: definition.domain,
    trial,
    status: cancelled ? "cancelled" : "failed",
    startedAt,
    finishedAt,
    durationMs,
    correctness: 0,
    sloCompliance: calculateSloCompliance(durationMs, config.sloMs),
    reward: 0,
    assertions: [],
    metrics: Object.freeze({
      assertion_count: 0,
      assertion_failure_count: 1,
    }),
    failure: {
      category: cancelled
        ? "infrastructure" as const
        : "bumblebee" as const,
      code: timedOut ? "SCENARIO_TIMEOUT" : normalized.code,
      message: timedOut
        ? `Scenario ${definition.id} exceeded its timeout`
        : `Scenario ${definition.id} terminated unexpectedly`,
      retryable: timedOut,
    },
  });
}

function createInfrastructureFailure(
  definition: ScenarioDefinition,
  trial: number,
  config: BumblebeeBenchScenarioConfig,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
  code: string,
  cause: unknown,
): ScenarioExecutionResult {
  const errorName = cause instanceof Error ? cause.name : "UnknownError";
  return Object.freeze({
    contractVersion: BUMBLEBEE_BENCH_CONTRACT_VERSION,
    scenarioId: definition.id,
    domain: definition.domain,
    trial,
    status: "invalid",
    startedAt,
    finishedAt,
    durationMs,
    correctness: 0,
    sloCompliance: calculateSloCompliance(durationMs, config.sloMs),
    reward: 0,
    assertions: [],
    metrics: Object.freeze({
      assertion_count: 0,
      assertion_failure_count: 1,
    }),
    failure: {
      category: "infrastructure" as const,
      code,
      message:
        `Scenario ${definition.id} infrastructure failed (${errorName})`,
      retryable: true,
    },
  });
}

function calculateSloCompliance(
  durationMs: number,
  targetMs: number,
): number {
  if (durationMs <= 0) {
    return 1;
  }
  return roundScore(Math.min(1, targetMs / durationMs));
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
