import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseBumblebeeBenchManifest,
  type BumblebeeBenchManifest,
  type ScenarioExecutionResult,
} from "../src/index.js";

export const BENCHMARK_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function loadFixtureManifest():
Promise<BumblebeeBenchManifest> {
  return parseBumblebeeBenchManifest(JSON.parse(
    await readFile(
      resolve(
        BENCHMARK_ROOT,
        "manifests",
        "bumblebee-bench-v1.json",
      ),
      "utf8",
    ),
  ) as unknown);
}

export function createPassingResults(
  manifest: BumblebeeBenchManifest,
  repetitions = 1,
): ScenarioExecutionResult[] {
  return manifest.domains.flatMap((domain) =>
    domain.scenarios.flatMap((scenario) =>
      Array.from({ length: repetitions }, (_, index) => ({
        contractVersion: 1 as const,
        scenarioId: scenario.id,
        domain: domain.id,
        trial: index + 1,
        status: "passed" as const,
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:00.010Z",
        durationMs: 10,
        correctness: 1,
        sloCompliance: 1,
        reward: 1,
        assertions: [{ id: "fixture-passed", passed: true }],
        metrics: {},
      })),
    ),
  );
}
