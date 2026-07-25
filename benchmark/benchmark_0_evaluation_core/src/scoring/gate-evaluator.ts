import {
  EVALUATION_CONTRACT_VERSION,
  assertMetricMap,
  assertScoreSpec,
  type GateDecision,
  type GateDefinition,
  type GateEvaluation,
  type ScoreSpec,
} from "../contracts/index.js";

/** 对已经聚合好的指标执行无副作用硬门槛判定。 */
export function evaluateHardGates(
  spec: ScoreSpec,
  metrics: Readonly<Record<string, number>>,
): GateEvaluation {
  assertScoreSpec(spec);
  assertMetricMap(metrics, "gateMetrics");

  const decisions = spec.hardGates.map((gate) =>
    evaluateGate(gate, metrics),
  );

  const hasMissingMetric = decisions.some(
    (decision) => decision.status === "missing",
  );
  const hasValidityFailure = decisions.some(
    (decision) =>
      decision.kind === "validity" && decision.status === "failed",
  );
  const hasQualificationFailure = decisions.some(
    (decision) =>
      decision.kind === "qualification" && decision.status === "failed",
  );

  return {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec: spec.id,
    status:
      hasMissingMetric || hasValidityFailure
        ? "invalid"
        : hasQualificationFailure
          ? "not-qualified"
          : "qualified",
    decisions,
  };
}

function evaluateGate(
  gate: GateDefinition,
  metrics: Readonly<Record<string, number>>,
): GateDecision {
  const actual = metrics[gate.metric];
  if (actual === undefined) {
    return {
      gateId: gate.id,
      kind: gate.kind,
      metric: gate.metric,
      operator: gate.operator,
      threshold: gate.threshold,
      status: "missing",
    };
  }

  return {
    gateId: gate.id,
    kind: gate.kind,
    metric: gate.metric,
    operator: gate.operator,
    threshold: gate.threshold,
    actual,
    status: compare(actual, gate.operator, gate.threshold)
      ? "passed"
      : "failed",
  };
}

function compare(
  actual: number,
  operator: GateDefinition["operator"],
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
