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
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
