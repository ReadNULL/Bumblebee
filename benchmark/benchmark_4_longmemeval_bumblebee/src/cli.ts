import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../src/foundation/index.js";
import {
  LONGMEMEVAL_PROFILES,
  loadLongMemEvalResources,
  type LongMemEvalProfile,
} from "./contracts/index.js";
import { PiMemoryReader } from "./reader/index.js";
import { runLongMemEvalBenchmark } from "./runner/index.js";

const execFileAsync = promisify(execFile);
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp();
    return;
  }
  if (args[0] !== "run") {
    throw invalidArgument(`unknown command: ${args[0]}`);
  }

  const projectRoot = process.cwd();
  await assertProjectRoot(projectRoot);
  const resources = await loadLongMemEvalResources(projectRoot);
  const profile = parseProfile(args[1]);
  const parsed = parseRunArguments(profile, args.slice(2));
  const subject = await inspectGitSubject(projectRoot);
  const observedPiVersion = await readInstalledPiVersion(
    projectRoot,
    resources.manifest.reader.piPackage,
  );
  const outputDirectory = parsed.outputDirectory ??
    path.join(
      projectRoot,
      "benchmark",
      "benchmark_4_longmemeval_bumblebee",
      "artifacts",
    );
  const reader = profile === "bumblebee-full"
    ? new PiMemoryReader({
        cwd: projectRoot,
        provider: parsed.provider as string,
        model: parsed.model as string,
        systemPrompt: resources.manifest.reader.systemPrompt,
        timeoutMs: resources.manifest.reader.taskTimeoutMs,
        ...(parsed.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: parsed.thinkingLevel }),
      })
    : undefined;
  const model = profile === "bumblebee-full"
    ? {
        provider: parsed.provider as string,
        id: parsed.model as string,
        ...(parsed.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: parsed.thinkingLevel }),
      }
    : undefined;

  const report = await runLongMemEvalBenchmark({
    manifest: resources.manifest,
    dataset: resources.dataset,
    datasetSha256: resources.datasetSha256,
    profile,
    ...(reader === undefined ? {} : { reader }),
    outputDirectory,
    hardwareProfile: parsed.hardwareProfile ?? "local-unspecified",
    observedPiVersion,
    bumblebeeCommit: subject.commit,
    workspaceClean: subject.clean,
    ...(model === undefined ? {} : { model }),
    ...(parsed.parentRunId === undefined
      ? {}
      : { parentRunId: parsed.parentRunId }),
  });
  printReport(report, outputDirectory);
}

interface ParsedRunArguments {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?:
    (typeof THINKING_LEVELS)[number];
  readonly outputDirectory?: string;
  readonly hardwareProfile?: string;
  readonly parentRunId?: string;
}

function parseRunArguments(
  profile: LongMemEvalProfile,
  args: readonly string[],
): ParsedRunArguments {
  if (profile === "memory-core") {
    if (args.length > 3) {
      throw invalidArgument("too many memory-core arguments");
    }
    const outputDirectory = optionalValue(args[0]);
    const hardwareProfile = optionalValue(args[1]);
    const parentRunId = optionalValue(args[2]);
    return Object.freeze({
      ...(outputDirectory === undefined
        ? {}
        : {
            outputDirectory: path.resolve(outputDirectory),
          }),
      ...(hardwareProfile === undefined
        ? {}
        : { hardwareProfile }),
      ...(parentRunId === undefined
        ? {}
        : { parentRunId }),
    });
  }

  const provider = optionalValue(args[0]);
  const model = optionalValue(args[1]);
  if (provider === undefined || model === undefined) {
    throw invalidArgument(
      "bumblebee-full requires provider and model",
    );
  }
  if (args.length > 6) {
    throw invalidArgument("too many bumblebee-full arguments");
  }
  const thinking = optionalValue(args[2]);
  if (
    thinking !== undefined &&
    !(THINKING_LEVELS as readonly string[]).includes(thinking)
  ) {
    throw invalidArgument(`unsupported thinking level: ${thinking}`);
  }
  const outputDirectory = optionalValue(args[3]);
  const hardwareProfile = optionalValue(args[4]);
  const parentRunId = optionalValue(args[5]);
  return Object.freeze({
    provider,
    model,
    ...(thinking === undefined
      ? {}
      : {
          thinkingLevel:
            thinking as (typeof THINKING_LEVELS)[number],
        }),
    ...(outputDirectory === undefined
      ? {}
      : {
          outputDirectory: path.resolve(outputDirectory),
        }),
    ...(hardwareProfile === undefined
      ? {}
      : { hardwareProfile }),
    ...(parentRunId === undefined
      ? {}
      : { parentRunId }),
  });
}

function parseProfile(value: string | undefined): LongMemEvalProfile {
  if (
    value === undefined ||
    !(LONGMEMEVAL_PROFILES as readonly string[]).includes(value)
  ) {
    throw invalidArgument(
      "profile must be memory-core or bumblebee-full",
    );
  }
  return value as LongMemEvalProfile;
}

function optionalValue(value: string | undefined): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

async function inspectGitSubject(
  projectRoot: string,
): Promise<{ readonly commit: string; readonly clean: boolean }> {
  const [commit, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    }),
    execFileAsync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    }),
  ]);
  return Object.freeze({
    commit: commit.stdout.trim(),
    clean: status.stdout.trim().length === 0,
  });
}

async function readInstalledPiVersion(
  projectRoot: string,
  packageName: string,
): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(
      path.join(projectRoot, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  ) as { readonly version?: unknown };
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.trim().length === 0
  ) {
    throw invalidArgument("installed pi package has no version");
  }
  return packageJson.version;
}

async function assertProjectRoot(projectRoot: string): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { readonly name?: unknown };
  if (packageJson.name !== "bumblebee") {
    throw invalidArgument(
      "Benchmark 4 must run from the Bumblebee repository root",
    );
  }
}

function printReport(
  report: Awaited<ReturnType<typeof runLongMemEvalBenchmark>>,
  outputDirectory: string,
): void {
  const score = report.score.score === null
    ? "N/A"
    : report.score.score.toFixed(2);
  process.stdout.write(
    [
      `LongMemEval-Bumblebee ${report.manifestVersion}`,
      `runId: ${report.runId}`,
      `profile: ${report.profile}`,
      `qualification: ${report.gateEvaluation.status}`,
      `LM score: ${score}`,
      `QA accuracy: ${report.componentScores.QAAccuracy.toFixed(2)}`,
      `Recall@5: ${report.componentScores.RecallAt5.toFixed(2)}`,
      `Precision@5: ${report.componentScores.PrecisionAt5.toFixed(2)}`,
      `Update accuracy: ${report.componentScores.UpdateAccuracy.toFixed(2)}`,
      `Abstention F1: ${report.componentScores.AbstentionF1.toFixed(2)}`,
      `Isolation accuracy: ${report.componentScores.IsolationAccuracy.toFixed(2)}`,
      `results: ${outputDirectory}`,
      "",
    ].join("\n"),
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run benchmark:4 -- run <profile> [arguments]",
      "",
      "Profiles:",
      "  memory-core",
      "    Replays real memory operations without a model. Always NQ.",
      "    Arguments: [output|-] [hardware|-] [parentRunId|-]",
      "",
      "  bumblebee-full",
      "    Runs the frozen 12-case suite three times through pi.",
      "    Arguments: <provider> <model> [thinking|-] [output|-] [hardware|-] [parentRunId|-]",
      "",
      "Examples:",
      "  npm run benchmark:4 -- run memory-core",
      "  npm run benchmark:4 -- run bumblebee-full openai gpt-4o high",
      "",
      "This adapted score is not an official LongMemEval leaderboard score.",
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
    message: "LongMemEval-Bumblebee benchmark failed",
  });
  process.stderr.write(
    `Benchmark 4 failed [${error.code}]: ${error.message}\n`,
  );
  process.exitCode = 1;
});
