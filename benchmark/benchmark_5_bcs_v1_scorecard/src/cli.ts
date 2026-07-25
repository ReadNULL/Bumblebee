import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../src/foundation/index.js";
import {
  loadBcsScorecardResources,
} from "./contracts/index.js";
import {
  calculateBcsEnvironmentRecoveryPublication,
  loadBcsEnvironmentRecoveryPublication,
  type BcsEnvironmentRecoveryResult,
} from "./publication/index.js";
import { runBcsScorecard } from "./runner/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.length === 0 ||
    args[0] === "help" ||
    args[0] === "--help"
  ) {
    printHelp();
    return;
  }
  const projectRoot = process.cwd();
  await assertProjectRoot(projectRoot);
  const resources = await loadBcsScorecardResources(projectRoot);
  if (args[0] === "publish") {
    if (args.length > 2) {
      throw invalidArgument(
        "publish accepts at most one publication manifest",
      );
    }
    const publication = args[1] === undefined
      ? await loadBcsEnvironmentRecoveryPublication(projectRoot)
      : await loadBcsEnvironmentRecoveryPublication(
          projectRoot,
          path.resolve(args[1]),
        );
    printPublication(
      calculateBcsEnvironmentRecoveryPublication(
        resources,
        publication,
      ),
    );
    return;
  }
  if (args[0] !== "score") {
    throw invalidArgument(`unknown command: ${args[0]}`);
  }
  if (args.length < 5 || args.length > 6) {
    throw invalidArgument(
      "score requires BB, TB, AD, and LM run directories",
    );
  }

  const outputDirectory = args[5] === undefined || args[5] === "-"
    ? path.join(
        projectRoot,
        "benchmark",
        "benchmark_5_bcs_v1_scorecard",
        "artifacts",
      )
    : path.resolve(args[5]);
  const result = await runBcsScorecard({
    resources,
    sourceDirectories: {
      BB: path.resolve(args[1] as string),
      TB: path.resolve(args[2] as string),
      AD: path.resolve(args[3] as string),
      LM: path.resolve(args[4] as string),
    },
    outputDirectory,
  });
  printResult(result);
}

function printPublication(
  result: BcsEnvironmentRecoveryResult,
): void {
  const terminal = result.components.find(
    (component) => component.id === "TB",
  );
  const validTaskRate = result.metrics.valid_task_rate;
  process.stdout.write(
    [
      "BCS-v1 formal project publication",
      `publicationId: ${result.publicationId}`,
      `mode: ${result.publicationMode}`,
      `qualification: ${result.score.qualification}`,
      `TB: ${terminal?.score.toFixed(2) ?? "N/A"}`,
      `BCS-v1: ${result.score.score?.toFixed(2) ?? "N/A"}`,
      `valid task rate: ${
        validTaskRate === undefined
          ? "N/A"
          : `${(validTaskRate * 100).toFixed(2)}%`
      }`,
      "boundary: project environment-recovery aggregate; not an official upstream or single-run score",
      "",
    ].join("\n"),
  );
}

async function assertProjectRoot(projectRoot: string): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { readonly name?: unknown };
  if (packageJson.name !== "bumblebee") {
    throw invalidArgument(
      "Benchmark 5 must run from the Bumblebee repository root",
    );
  }
}

function printResult(
  result: Awaited<ReturnType<typeof runBcsScorecard>>,
): void {
  const score = result.report.score.score === null
    ? "N/A"
    : result.report.score.score.toFixed(2);
  const reportPath = path.join(
    result.outputDirectory,
    ...result.artifacts.markdown.relativePath.split("/"),
  );
  process.stdout.write(
    [
      `BCS-v1 Scorecard ${result.report.manifestVersion}`,
      `scorecardId: ${result.report.scorecardId}`,
      `qualification: ${result.report.qualification}`,
      `BCS-v1: ${score}`,
      ...result.report.sources.map((source) =>
        `${source.component}: ` +
        (source.score === null ? "N/A" : source.score.toFixed(2))
      ),
      `report: ${reportPath}`,
      "",
    ].join("\n"),
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npm run benchmark:5 -- score <BB_RUN_DIR> <TB_RUN_DIR> <AD_RUN_DIR> <LM_RUN_DIR> [OUTPUT|-]",
      "  npm run benchmark:5 -- publish [PUBLICATION_MANIFEST]",
      "  npm run benchmark:score -- score <BB_RUN_DIR> <TB_RUN_DIR> <AD_RUN_DIR> <LM_RUN_DIR> [OUTPUT|-]",
      "  npm run benchmark:score -- publish [PUBLICATION_MANIFEST]",
      "",
      "Each input must be a Benchmark 0 run directory:",
      "  <suite-output>/artifacts/<runId>",
      "",
      "The command never invokes a model. It verifies source artifacts,",
      "checks cross-suite identity, applies BCS-v1 gates and writes an",
      "immutable JSON/Markdown scorecard.",
      "",
      "publish validates the frozen environment-recovery publication",
      "manifest and calculates the formal project TB and BCS-v1 scores.",
      "",
    ].join("\n"),
  );
}

function invalidArgument(message: string): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
  });
}

void main().catch((cause: unknown) => {
  const error = normalizeError(cause, {
    message: "BCS-v1 scorecard failed",
  });
  process.stderr.write(
    `Benchmark 5 failed [${error.code}]: ${error.message}\n`,
  );
  process.exitCode = 1;
});
