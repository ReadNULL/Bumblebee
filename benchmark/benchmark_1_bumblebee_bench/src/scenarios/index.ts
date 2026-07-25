import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import type { BumblebeeBenchManifest } from "../contracts/index.js";
import type { ScenarioDefinition } from "../runner/index.js";
import { CANCELLATION_SCENARIOS } from "./cancellation.js";
import { CHANNEL_SCENARIOS } from "./channel.js";
import { MEMORY_SCENARIOS } from "./memory.js";
import { PERMISSION_SCENARIOS } from "./permission.js";
import { RUNTIME_SCENARIOS } from "./runtime.js";
import { SUBAGENT_SCENARIOS } from "./subagent.js";

const SCENARIOS: readonly ScenarioDefinition[] = Object.freeze([
  ...RUNTIME_SCENARIOS,
  ...CANCELLATION_SCENARIOS,
  ...PERMISSION_SCENARIOS,
  ...SUBAGENT_SCENARIOS,
  ...CHANNEL_SCENARIOS,
  ...MEMORY_SCENARIOS,
]);

/** 按冻结 manifest 顺序返回实现，并拒绝遗漏、重复或挂错 domain。 */
export function getScenarioDefinitions(
  manifest: BumblebeeBenchManifest,
): readonly ScenarioDefinition[] {
  const definitions = new Map(
    SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  const ordered: ScenarioDefinition[] = [];

  for (const domain of manifest.domains) {
    for (const scenario of domain.scenarios) {
      const definition = definitions.get(scenario.id);
      if (
        definition === undefined ||
        definition.domain !== domain.id
      ) {
        throw new BumblebeeError(
          "benchmark scenario implementation does not match manifest",
          {
            code: ERROR_CODES.CONFLICT,
            context: {
              domain: domain.id,
              scenarioId: scenario.id,
            },
          },
        );
      }
      ordered.push(definition);
      definitions.delete(scenario.id);
    }
  }

  if (definitions.size > 0) {
    throw new BumblebeeError(
      "benchmark contains unversioned scenario implementations",
      {
        code: ERROR_CODES.CONFLICT,
        context: { scenarioIds: [...definitions.keys()] },
      },
    );
  }
  return Object.freeze(ordered);
}

export {
  CANCELLATION_SCENARIOS,
  CHANNEL_SCENARIOS,
  MEMORY_SCENARIOS,
  PERMISSION_SCENARIOS,
  RUNTIME_SCENARIOS,
  SUBAGENT_SCENARIOS,
};
