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

  it("canonicalizes quota failures without retrying them", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      exceptionType: "UnknownApiError",
      exceptionMessage: "402 Insufficient Balance",
    });

    expect(job.trials[0]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "infrastructure",
        code: "HARBOR_APIUSAGELIMITERROR",
        retryable: false,
      },
    });
  });

  it("treats an unavailable package index as infrastructure", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      exceptionType: "NonZeroAgentExitCodeError",
      exceptionMessage:
        "Could not find a version that satisfies the requirement " +
        "pytest==8.4.1 (from versions: none)",
      exceptionDuringSetup: true,
    });

    expect(job.trials[0]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "infrastructure",
        code: "HARBOR_NETWORKCONNECTIONERROR",
        retryable: true,
      },
    });
  });

  it("does not excuse package errors from agent execution", () => {
    const manifest = createTestManifest();
    const job = createNormalizedFixtureJob(manifest, {
      exceptionType: "NonZeroAgentExitCodeError",
      exceptionMessage:
        "No matching distribution found for imaginary-package",
      rewards: [0, 1, 1, 1],
    });

    expect(job.trials[0]).toMatchObject({
      status: "failed",
      stable: false,
      failure: {
        category: "bumblebee",
        code: "HARBOR_NONZEROAGENTEXITCODEERROR",
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

  it("canonicalizes Harbor local and microsecond timestamps to UTC", () => {
    const manifest = createTestManifest();
    const raw = createRawFixtureJob(manifest);
    const localStartedAt = "2026-07-23T09:59:00.123456";
    const localFinishedAt = "2026-07-23T10:02:00.654321";
    const trialStartedAt = "2026-07-23T10:00:00.123456Z";
    raw.result.started_at = localStartedAt;
    raw.result.finished_at = localFinishedAt;
    raw.result.trial_results[0]!.started_at = trialStartedAt;

    const job = normalizeHarborJob(
      raw.config,
      raw.result,
      {
        configSha256: "a".repeat(64),
        resultSha256: "b".repeat(64),
        trialResultsSha256: "c".repeat(64),
        sourceDirectoryName: "fixture",
      },
      manifest,
    );

    expect(job.startedAt).toBe(new Date(localStartedAt).toISOString());
    expect(job.finishedAt).toBe(
      new Date(localFinishedAt).toISOString(),
    );
    expect(job.trials[0]?.startedAt).toBe(
      new Date(trialStartedAt).toISOString(),
    );
  });
});
