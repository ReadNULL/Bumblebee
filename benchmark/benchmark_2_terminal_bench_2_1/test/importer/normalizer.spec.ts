import { describe, expect, it } from "vitest";

import {
  normalizeHarborJob,
} from "../../src/index.js";
import {
  createNormalizedFixtureJob,
  createRawFixtureJob,
  createTestManifest,
} from "../fixtures.js";

describe("Harbor job normalizer", () => {
  it("normalizes official reward, usage, timing and trial numbers", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest);

    expect(job.datasetId).toBe(manifest.dataset.id);
    expect(job.datasetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(job.trials).toHaveLength(4);
    expect(job.trials.map((trial) => trial.trial)).toEqual([
      1,
      2,
      1,
      2,
    ]);
    expect(job.trials[0]).toMatchObject({
      taskId: "task-alpha",
      reward: 1,
      agentDurationMs: 2_000,
      costUsd: 2,
      stable: true,
      tokens: {
        input: 100,
        output: 20,
        cacheRead: 10,
      },
    });
  });

  it("marks provider infrastructure failures invalid", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      exceptionType: "ApiRateLimitError",
    });

    expect(job.trials[0]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "infrastructure",
        retryable: true,
      },
    });
  });

  it("keeps an agent failure scoreable when verifier evidence exists", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      exceptionType: "NonZeroAgentExitCodeError",
      rewards: [0, 1, 1, 1],
    });

    expect(job.trials[0]).toMatchObject({
      status: "failed",
      reward: 0,
      stable: false,
      failure: {
        category: "bumblebee",
      },
    });
  });

  it("applies Harbor defaults omitted by exclude_defaults", () => {
    const manifest = createTestManifest();
    const raw = createRawFixtureJob(manifest);
    const {
      n_concurrent_trials: _concurrency,
      environment: _environment,
      ...minimalConfig
    } = raw.config;
    const job = normalizeHarborJob(
      minimalConfig,
      raw.result,
      {
        configSha256: "a".repeat(64),
        resultSha256: "b".repeat(64),
        trialResultsSha256: "c".repeat(64),
        sourceDirectoryName: "fixture",
      },
      manifest,
    );

    expect(job.concurrency).toBe(4);
    expect(job.environmentType).toBe("docker");
  });
});
