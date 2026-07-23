import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import { assertIdentifier } from "../../../benchmark_0_evaluation_core/src/index.js";
import type {
  BumblebeeBenchDomain,
  ScenarioObservation,
} from "../contracts/index.js";

export interface ScenarioExecutionContext {
  readonly fixtureDirectory: string;
  readonly signal: AbortSignal;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly domain: BumblebeeBenchDomain;
  run(
    context: ScenarioExecutionContext,
    probe: ScenarioProbe,
  ): Promise<void>;
}

/** 场景只记录断言 ID 和数值指标，不把测试数据原文写入证据。 */
export class ScenarioProbe {
  private readonly assertionIds = new Set<string>();
  private readonly assertions: Array<{
    readonly id: string;
    readonly passed: boolean;
  }> = [];
  private readonly metrics: Record<string, number> = Object.create(null);

  check(id: string, passed: boolean): void {
    assertIdentifier(id, "assertion.id");
    if (this.assertionIds.has(id)) {
      throw new BumblebeeError("scenario assertion id is duplicated", {
        code: ERROR_CODES.CONFLICT,
        context: { assertionId: id },
      });
    }

    this.assertionIds.add(id);
    this.assertions.push(Object.freeze({ id, passed }));
  }

  metric(id: string, value: number): void {
    assertIdentifier(id, "metric.id");
    if (!Number.isFinite(value)) {
      throw new BumblebeeError("scenario metric must be finite", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { metricId: id, value },
      });
    }
    this.metrics[id] = value;
  }

  increment(id: string, amount = 1): void {
    if (!Number.isFinite(amount)) {
      throw new BumblebeeError(
        "scenario metric increment must be finite",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { amount, metricId: id },
        },
      );
    }
    this.metric(id, (this.metrics[id] ?? 0) + amount);
  }

  snapshot(): ScenarioObservation {
    if (this.assertions.length === 0) {
      throw new BumblebeeError(
        "scenario completed without recording an assertion",
        { code: ERROR_CODES.INTERNAL },
      );
    }

    return Object.freeze({
      assertions: Object.freeze([...this.assertions]),
      metrics: Object.freeze({ ...this.metrics }),
    });
  }
}
