import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import {
  EVALUATION_CONTRACT_VERSION,
  assertGateEvaluation,
  assertScoreSpec,
  type CompositeScore,
  type GateEvaluation,
  type ScoreSpec,
} from "../contracts/index.js";

/**
 * 仅在硬门槛通过时计算加权分。未通过时保留 qualification，
 * score 为 null，避免误把 NQ/invalid 当作低分发布。
 */
export function calculateCompositeScore(
  spec: ScoreSpec,
  componentScores: Readonly<Record<string, number>>,
  gateEvaluation: GateEvaluation,
): CompositeScore {
  assertScoreSpec(spec);
  assertGateEvaluation(gateEvaluation);

  if (gateEvaluation.scoreSpec !== spec.id) {
    invalid("gate evaluation does not match score spec");
  }
  assertGateCoverage(spec, gateEvaluation);

  if (gateEvaluation.status !== "qualified") {
    return {
      contractVersion: EVALUATION_CONTRACT_VERSION,
      scoreSpec: spec.id,
      qualification: gateEvaluation.status,
      score: null,
      components: [],
    };
  }

  const expectedIds = new Set(
    spec.components.map((component) => component.id),
  );
  for (const key of Object.keys(componentScores)) {
    if (!expectedIds.has(key)) {
      invalid("component score contains an unknown component", {
        componentId: key,
      });
    }
  }

  const components = spec.components.map((component) => {
    const score = componentScores[component.id];
    if (score === undefined) {
      invalid("component score is missing", {
        componentId: component.id,
      });
    }
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      invalid("component score must be between 0 and 100", {
        componentId: component.id,
        score,
      });
    }

    return {
      id: component.id,
      score,
      weight: component.weight,
      contribution: round(score * component.weight),
    };
  });
  const score = round(
    components.reduce(
      (total, component) => total + component.contribution,
      0,
    ),
  );

  return {
    contractVersion: EVALUATION_CONTRACT_VERSION,
    scoreSpec: spec.id,
    qualification: "qualified",
    score,
    components,
  };
}

function assertGateCoverage(
  spec: ScoreSpec,
  gateEvaluation: GateEvaluation,
): void {
  if (gateEvaluation.decisions.length !== spec.hardGates.length) {
    invalid("gate evaluation does not cover every required gate");
  }

  const decisions = new Map(
    gateEvaluation.decisions.map((decision) => [
      decision.gateId,
      decision,
    ]),
  );
  for (const gate of spec.hardGates) {
    const decision = decisions.get(gate.id);
    if (
      decision === undefined ||
      decision.kind !== gate.kind ||
      decision.metric !== gate.metric ||
      decision.operator !== gate.operator ||
      decision.threshold !== gate.threshold
    ) {
      invalid("gate evaluation does not match gate definition", {
        gateId: gate.id,
      });
    }
  }
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
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
