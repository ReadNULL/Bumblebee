import {
  mkdir,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readHarborJob } from "../../src/index.js";
import {
  createRawFixtureJob,
  createTestManifest,
} from "../fixtures.js";

describe("Harbor job reader", () => {
  it("reads and hashes the current root JobResult layout", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-job-"),
    );
    const raw = createRawFixtureJob(manifest);
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(join(directory, "result.json"), raw.result);

    const job = await readHarborJob(directory, manifest);

    expect(job.trials).toHaveLength(4);
    expect(job.provenance).toMatchObject({
      sourceDirectoryName: expect.stringContaining(
        "bumblebee-harbor-job-",
      ),
      configSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      trialResultsSha256: expect.stringMatching(
        /^[a-f0-9]{64}$/u,
      ),
    });
  });

  it("falls back to child trial results without losing provenance", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-fallback-"),
    );
    const raw = createRawFixtureJob(manifest);
    const {
      trial_results: _trialResults,
      ...result
    } = raw.result;
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(join(directory, "result.json"), result);

    for (
      let index = 0;
      index < raw.result.trial_results.length;
      index += 1
    ) {
      const trial = raw.result.trial_results[index];
      const trialDirectory = join(directory, `trial-${index}`);
      await mkdir(trialDirectory);
      await writeJson(
        join(trialDirectory, "result.json"),
        trial,
      );
    }

    const job = await readHarborJob(directory, manifest);

    expect(job.trials).toHaveLength(4);
    expect(job.provenance.trialResultsSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("separates verifier bootstrap network failures from model failures", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-verifier-"),
    );
    const raw = createRawFixtureJob(manifest, {
      rewards: [0, 0, 0, 1],
    });
    const {
      trial_results: trialResults,
      ...result
    } = raw.result;
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(join(directory, "result.json"), result);

    for (
      let index = 0;
      index < trialResults.length;
      index += 1
    ) {
      const trial = trialResults[index];
      if (trial === undefined) {
        continue;
      }
      const trialDirectory = join(
        directory,
        trial.trial_name,
      );
      await mkdir(join(trialDirectory, "verifier"), {
        recursive: true,
      });
      await writeJson(
        join(trialDirectory, "result.json"),
        trial,
      );
      if (index === 0) {
        await writeFile(
          join(
            trialDirectory,
            "verifier",
            "test-stdout.txt",
          ),
          [
            "Failed to download distribution due to network timeout.",
            "Try increasing UV_HTTP_TIMEOUT (current value: 30s).",
            "",
          ].join("\n"),
          "utf8",
        );
      } else if (index === 1) {
        await writeFile(
          join(
            trialDirectory,
            "verifier",
            "test-stdout.txt",
          ),
          [
            "curl: (35) OpenSSL SSL_ERROR_SYSCALL in connection to astral.sh:443",
            "/tests/test.sh: line 19: uvx: command not found",
            "",
          ].join("\n"),
          "utf8",
        );
      } else if (index === 2) {
        await writeFile(
          join(
            trialDirectory,
            "verifier",
            "test-stdout.txt",
          ),
          "application assertion mentioned a network timeout\n",
          "utf8",
        );
      }
    }

    const job = await readHarborJob(directory, manifest);

    expect(job.trials[0]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "infrastructure",
        code: "HARBOR_VERIFIERINFRASTRUCTUREERROR",
        retryable: true,
      },
    });
    expect(job.trials[1]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "infrastructure",
        code: "HARBOR_VERIFIERINFRASTRUCTUREERROR",
        retryable: true,
      },
    });
    expect(job.trials[2]).toMatchObject({
      status: "failed",
      stable: true,
      failure: {
        category: "model",
        code: "OFFICIAL_REWARD_ZERO",
      },
    });
    expect(job.provenance.trialResultsSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("invalidates trials that access benchmark-only evidence", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-leak-"),
    );
    const raw = createRawFixtureJob(manifest);
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(join(directory, "result.json"), raw.result);
    const leakedTrial = raw.result.trial_results[0];
    if (leakedTrial === undefined) {
      throw new Error("fixture must contain a trial");
    }
    const agentDirectory = join(
      directory,
      leakedTrial.trial_name,
      "agent",
    );
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, "pi.txt"),
      [
        "read /root/.bumblebee-benchmark/benchmark/",
        "benchmark_2_terminal_bench_2_1/",
        "POSTMORTEM_2026-07-24.md",
      ].join(""),
      "utf8",
    );

    const job = await readHarborJob(directory, manifest);

    expect(job.trials[0]).toMatchObject({
      status: "invalid",
      stable: false,
      failure: {
        category: "dataset",
        code: "HARBOR_BENCHMARKEVIDENCELEAKERROR",
        retryable: false,
      },
    });
    expect(job.trials.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stable: true }),
      ]),
    );
  });

  it("preserves completed trials from an interrupted job", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-interrupted-"),
    );
    const raw = createRawFixtureJob(manifest);
    const {
      finished_at: _finishedAt,
      trial_results,
      ...interruptedResult
    } = raw.result;
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(
      join(directory, "result.json"),
      interruptedResult,
    );
    const trialDirectory = join(directory, "completed-trial");
    await mkdir(trialDirectory);
    await writeJson(
      join(trialDirectory, "result.json"),
      trial_results[0],
    );

    const job = await readHarborJob(directory, manifest);

    expect(job.trials).toHaveLength(1);
    expect(job.nTotalTrials).toBe(4);
    expect(job.finishedAt).toBe(
      interruptedResult.updated_at,
    );
  });

  it("accepts model-less identities only for explicit preflight reads", async () => {
    const manifest = createTestManifest();
    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-harbor-preflight-"),
    );
    const raw = createRawFixtureJob(manifest);
    const result = {
      ...raw.result,
      trial_results: raw.result.trial_results.map((trial) => ({
        ...trial,
        agent_info: {
          ...trial.agent_info,
          model_info: null,
        },
      })),
    };
    await writeJson(join(directory, "config.json"), raw.config);
    await writeJson(join(directory, "result.json"), result);

    await expect(
      readHarborJob(directory, manifest),
    ).rejects.toThrow("agent_info.model_info must be an object");

    const job = await readHarborJob(directory, manifest, {
      allowModelLessTrials: true,
    });

    expect(job.trials[0]?.identity).toMatchObject({
      modelProvider: "none",
      modelName: "none",
    });
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
