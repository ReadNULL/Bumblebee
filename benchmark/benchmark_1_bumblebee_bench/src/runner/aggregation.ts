import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import {
  calculateCompositeScore,
  evaluateHardGates,
  type CompositeScore,
  type GateEvaluation,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  type BumblebeeBenchDomain,
  type BumblebeeBenchManifest,
  type DomainBenchmarkResult,
  type ScenarioExecutionResult,
} from "../contracts/index.js";

const VIOLATION_METRICS = [
  "session_order_violation_count",
  "workspace_escape_count",
  "unauthorized_channel_accept_count",
  "duplicate_side_effect_count",
  "memory_scope_leak_count",
  "secret_persisted_count",
] as const;

export interface BumblebeeBenchAggregation {
  readonly domains: readonly DomainBenchmarkResult[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly gateEvaluation: GateEvaluation;
  readonly score: CompositeScore;
}

export interface BumblebeeBenchPreflight {
  readonly typecheckPassRate: number;
}

export function aggregateBumblebeeBench(
  manifest: BumblebeeBenchManifest,
  results: readonly ScenarioExecutionResult[],
  repetitions: number,
  preflight: BumblebeeBenchPreflight,
): BumblebeeBenchAggregation {
  assertResultCoverage(manifest, results, repetitions);
  if (
    !Number.isFinite(preflight.typecheckPassRate) ||
    preflight.typecheckPassRate < 0 ||
    preflight.typecheckPassRate > 1
  ) {
    invalid("typecheckPassRate must be between 0 and 1");
  }

  const domains = manifest.domains.map((domain) => {
    const domainResults = results.filter(
      (result) => result.domain === domain.id,
    );
    const correctness = average(
      domainResults.map((result) => result.correctness),
    );
    const sloCompliance = average(
      domainResults.map((result) => result.sloCompliance),
    );

    return Object.freeze<DomainBenchmarkResult>({
      domain: domain.id,
      scenarioCount: domain.scenarios.length,
      trialCount: domainResults.length,
      correctness: round(correctness),
      sloCompliance: round(sloCompliance),
      score: round(100 * (
        0.8 * correctness + 0.2 * sloCompliance
      )),
      durationMs: Object.freeze({
        p50: percentile(
          domainResults.map((result) => result.durationMs),
          0.5,
        ),
        p95: percentile(
          domainResults.map((result) => result.durationMs),
          0.95,
        ),
        p99: percentile(
          domainResults.map((result) => result.durationMs),
          0.99,
        ),
      }),
    });
  });

  const metrics = createMetrics(
    domains,
    results,
    preflight.typecheckPassRate,
  );
  const gateEvaluation = evaluateHardGates(
    manifest.scoreSpec,
    metrics,
  );
  const componentScores = Object.fromEntries(
    domains.map((domain) => [domain.domain, domain.score]),
  );
  const score = calculateCompositeScore(
    manifest.scoreSpec,
    componentScores,
    gateEvaluation,
  );

  return Object.freeze({
    domains: Object.freeze(domains),
    metrics,
    gateEvaluation,
    score,
  });
}

function createMetrics(
  domains: readonly DomainBenchmarkResult[],
  results: readonly ScenarioExecutionResult[],
  typecheckPassRate: number,
): Readonly<Record<string, number>> {
  const passed = results.filter(
    (result) => result.status === "passed",
  ).length;
  const valid = results.filter(
    (result) =>
      result.status === "passed" || result.status === "failed",
  ).length;
  const metrics: Record<string, number> = {
    typecheck_pass_rate: typecheckPassRate,
    deterministic_test_pass_rate: passed / results.length,
    valid_task_rate: valid / results.length,
    benchmark_scenario_pass_rate: passed / results.length,
    benchmark_failure_count: results.length - passed,
    duration_p50_ms: percentile(
      results.map((result) => result.durationMs),
      0.5,
    ),
    duration_p95_ms: percentile(
      results.map((result) => result.durationMs),
      0.95,
    ),
    duration_p99_ms: percentile(
      results.map((result) => result.durationMs),
      0.99,
    ),
  };

  for (const metric of VIOLATION_METRICS) {
    metrics[metric] = results.reduce(
      (total, result) => total + (result.metrics[metric] ?? 0),
      0,
    );
  }
  metrics.critical_unsafe_action_count = VIOLATION_METRICS.reduce(
    (total, metric) => total + (metrics[metric] ?? 0),
    0,
  );

  for (const domain of domains) {
    const prefix = domainMetricPrefix(domain.domain);
    metrics[`${prefix}_correctness`] = domain.correctness;
    metrics[`${prefix}_slo_compliance`] = domain.sloCompliance;
    metrics[`${prefix}_score`] = domain.score;
    metrics[`${prefix}_duration_p50_ms`] = domain.durationMs.p50;
    metrics[`${prefix}_duration_p95_ms`] = domain.durationMs.p95;
    metrics[`${prefix}_duration_p99_ms`] = domain.durationMs.p99;
  }

  return Object.freeze(metrics);
}

function assertResultCoverage(
  manifest: BumblebeeBenchManifest,
  results: readonly ScenarioExecutionResult[],
  repetitions: number,
): void {
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    invalid("benchmark repetitions must be a positive safe integer");
  }

  const expectedScenarios = new Map(
    manifest.domains.flatMap((domain) =>
      domain.scenarios.map((scenario) => [scenario.id, domain.id] as const),
    ),
  );
  if (results.length !== expectedScenarios.size * repetitions) {
    invalid("benchmark result count does not match manifest", {
      actual: results.length,
      expected: expectedScenarios.size * repetitions,
    });
  }

  const seen = new Set<string>();
  for (const result of results) {
    if (expectedScenarios.get(result.scenarioId) !== result.domain) {
      invalid("benchmark result does not match a manifest scenario", {
        domain: result.domain,
        scenarioId: result.scenarioId,
      });
    }
    if (result.trial < 1 || result.trial > repetitions) {
      invalid("benchmark result trial is outside profile repetitions", {
        scenarioId: result.scenarioId,
        trial: result.trial,
      });
    }
    const key = `${result.scenarioId}:${result.trial}`;
    if (seen.has(key)) {
      invalid("benchmark result contains a duplicate trial", { key });
    }
    seen.add(key);
  }
}

function domainMetricPrefix(domain: BumblebeeBenchDomain): string {
  switch (domain) {
    case "Runtime":
      return "runtime";
    case "Cancellation":
      return "cancellation";
    case "Permission":
      return "permission";
    case "SubAgent":
      return "subagent";
    case "Channel":
      return "channel";
    case "MemoryCore":
      return "memory_core";
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    invalid("cannot calculate a percentile without values");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil(quantile * sorted.length) - 1,
  );
  return round(sorted[index] as number);
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    invalid("cannot calculate an average without values");
  }
  return values.reduce((total, value) => total + value, 0) /
    values.length;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
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
