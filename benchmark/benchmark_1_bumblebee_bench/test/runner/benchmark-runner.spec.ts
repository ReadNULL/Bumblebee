import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBumblebeeBench } from "../../src/index.js";
import { loadFixtureManifest } from "../fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BumblebeeBench runner", () => {
  it("runs all real smoke scenarios through Benchmark 0 recording", async () => {
    const outputDirectory = await createTemporaryDirectory();
    const report = await runBumblebeeBench({
      manifest: await loadFixtureManifest(),
      profile: "smoke",
      outputDirectory,
      datasetHash: "a".repeat(64),
      subject: {
        bumblebeeCommit: "fixture",
        workspaceClean: true,
        piVersion: "fixture",
      },
      environment: {
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        hardwareProfile: "fixture",
      },
      typecheckPassRate: 1,
    });

    expect(report.scenarioResults).toHaveLength(12);
    expect(
      report.scenarioResults.every(
        (result) => result.status === "passed",
      ),
    ).toBe(true);
    expect(report.gateEvaluation.status).toBe("qualified");
    expect(report.score.score).toBe(100);

    const ledger = await readFile(
      join(outputDirectory, "history", "runs.jsonl"),
      "utf8",
    );
    const events = ledger.trim().split(/\r?\n/u).map(
      (line) => (JSON.parse(line) as { event: string }).event,
    );
    expect(events).toEqual(["run_started", "run_finished"]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "bumblebee-bench-runner-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}
