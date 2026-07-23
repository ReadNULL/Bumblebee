import { abortableSleep } from "../../../../src/foundation/index.js";
import { describe, expect, it } from "vitest";

import {
  executeScenario,
  type BumblebeeBenchScenarioConfig,
  type ScenarioDefinition,
} from "../../src/index.js";

const config: BumblebeeBenchScenarioConfig = {
  id: "fixture-scenario",
  description: "Fixture",
  sloMs: 100,
  timeoutMs: 500,
};

describe("scenario runner", () => {
  it("turns explicit assertions and metrics into a scored result", async () => {
    const definition: ScenarioDefinition = {
      id: config.id,
      domain: "Runtime",
      async run(_context, probe) {
        probe.check("first-condition", true);
        probe.check("second-condition", false);
        probe.metric("fixture_metric", 3);
      },
    };

    const result = await executeScenario(definition, config, 1);

    expect(result).toMatchObject({
      status: "failed",
      correctness: 0.5,
      trial: 1,
      metrics: {
        assertion_count: 2,
        assertion_failure_count: 1,
        fixture_metric: 3,
      },
      failure: {
        category: "bumblebee",
        code: "ASSERTION_FAILED",
      },
    });
  });

  it("classifies a cooperative scenario timeout as a product failure", async () => {
    const definition: ScenarioDefinition = {
      id: "timeout-fixture",
      domain: "Cancellation",
      async run({ signal }, _probe) {
        await abortableSleep(1_000, signal);
      },
    };
    const timeoutConfig = {
      ...config,
      id: definition.id,
      sloMs: 5,
      timeoutMs: 10,
    };

    const result = await executeScenario(
      definition,
      timeoutConfig,
      1,
    );

    expect(result).toMatchObject({
      status: "failed",
      reward: 0,
      failure: {
        category: "bumblebee",
        code: "SCENARIO_TIMEOUT",
      },
    });
  });
});
