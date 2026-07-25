import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadBcsScorecardResources,
  runBcsScorecard,
} from "../../src/index.js";
import {
  createAllSourceRuns,
  projectRoot,
} from "../fixtures.js";

describe("BCS scorecard runner", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "bumblebee-bcs-runner-"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("imports four runs and writes immutable JSON and Markdown artifacts", async () => {
    const resources = await loadBcsScorecardResources(projectRoot);
    const sourceDirectories = await createAllSourceRuns(
      path.join(temporaryDirectory, "sources"),
      resources,
    );
    const outputDirectory = path.join(
      temporaryDirectory,
      "scorecards",
    );

    const result = await runBcsScorecard({
      resources,
      sourceDirectories,
      outputDirectory,
      clock: () => new Date("2026-07-23T12:00:00.000Z"),
      scorecardIdFactory: () => "scorecard_fixture",
    });

    expect(result.report.qualification).toBe("qualified");
    expect(result.artifacts.sourceSnapshots).toHaveLength(4);
    const reportPath = path.join(
      outputDirectory,
      ...result.artifacts.report.relativePath.split("/"),
    );
    const markdownPath = path.join(
      outputDirectory,
      ...result.artifacts.markdown.relativePath.split("/"),
    );
    const persisted = JSON.parse(
      await readFile(reportPath, "utf8"),
    ) as { scorecardId: string; score: { score: number | null } };
    expect(persisted.scorecardId).toBe("scorecard_fixture");
    expect(persisted.score.score).not.toBeNull();
    expect(await readFile(markdownPath, "utf8")).toContain(
      "# BCS-v1 Scorecard",
    );
  });
});
