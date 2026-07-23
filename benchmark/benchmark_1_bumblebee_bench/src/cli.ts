import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpus,
  totalmem,
} from "node:os";
import {
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../src/foundation/index.js";
import {
  BUMBLEBEE_BENCH_PROFILES,
  parseBumblebeeBenchManifest,
  type BumblebeeBenchProfile,
} from "./contracts/index.js";
import { runBumblebeeBench } from "./runner/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MANIFEST_PATH =
  "benchmark/benchmark_1_bumblebee_bench/" +
  "manifests/bumblebee-bench-v1.json";
const DEFAULT_OUTPUT_PATH =
  "benchmark/benchmark_1_bumblebee_bench/.runtime/evaluation";

interface CliOptions {
  readonly help: boolean;
  readonly outputDirectory: string;
  readonly parentRunId?: string;
  readonly profile: BumblebeeBenchProfile;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const cli = parseArguments(process.argv.slice(2), projectRoot);
  if (cli.help) {
    printHelp();
    return;
  }

  const manifestPath = path.join(projectRoot, DEFAULT_MANIFEST_PATH);
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseBumblebeeBenchManifest(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
  );
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as {
    readonly name?: string;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  if (packageJson.name !== "bumblebee") {
    throw new BumblebeeError(
      "BumblebeeBench must run from the repository root",
      { code: ERROR_CODES.INVALID_INPUT },
    );
  }

  const [
    commit,
    status,
    typecheckPassRate,
    deterministicTestPassRate,
  ] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "HEAD"]),
    runGit(projectRoot, ["status", "--porcelain"]),
    runTypecheck(projectRoot),
    runDeterministicTests(projectRoot),
  ]);
  const controller = new AbortController();
  const onInterrupt = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        new BumblebeeError("Benchmark interrupted", {
          code: ERROR_CODES.CANCELLED,
        }),
      );
    }
  };
  process.once("SIGINT", onInterrupt);

  try {
    const report = await runBumblebeeBench({
      manifest,
      profile: cli.profile,
      outputDirectory: cli.outputDirectory,
      datasetHash: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      subject: {
        bumblebeeCommit: commit,
        workspaceClean: status.length === 0,
        piVersion:
          packageJson.devDependencies
            ?.[
              "@earendil-works/pi-coding-agent"
            ] ?? "unknown",
      },
      environment: {
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        hardwareProfile: createHardwareProfile(),
      },
      typecheckPassRate,
      deterministicTestPassRate,
      ...(cli.parentRunId === undefined
        ? {}
        : { parentRunId: cli.parentRunId }),
      signal: controller.signal,
    });

    printReport(report, cli.outputDirectory);
    process.exitCode = report.gateEvaluation.status === "qualified"
      ? 0
      : report.gateEvaluation.status === "not-qualified"
        ? 2
        : 3;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

function parseArguments(
  arguments_: readonly string[],
  projectRoot: string,
): CliOptions {
  let profile: BumblebeeBenchProfile = "smoke";
  let outputDirectory = process.env.BUMBLEBEE_BENCH_OUTPUT ??
    path.join(projectRoot, DEFAULT_OUTPUT_PATH);
  let parentRunId: string | undefined;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--profile") {
      const value = arguments_[index + 1];
      if (
        value === undefined ||
        !BUMBLEBEE_BENCH_PROFILES.includes(
          value as BumblebeeBenchProfile,
        )
      ) {
        throw invalidArgument("--profile must be smoke or full");
      }
      profile = value as BumblebeeBenchProfile;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw invalidArgument("--output requires a directory");
      }
      outputDirectory = path.resolve(projectRoot, value);
      index += 1;
      continue;
    }
    if (argument === "--parent-run-id") {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw invalidArgument("--parent-run-id requires a value");
      }
      parentRunId = value.trim();
      index += 1;
      continue;
    }
    throw invalidArgument(`unknown argument: ${String(argument)}`);
  }

  return {
    help,
    outputDirectory: path.resolve(outputDirectory),
    profile,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  };
}

async function runGit(
  cwd: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function runTypecheck(projectRoot: string): Promise<number> {
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join("node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return 1;
  } catch (cause: unknown) {
    const error = normalizeError(cause, {
      message: "Typecheck preflight failed",
    });
    process.stderr.write(
      `Typecheck preflight failed [${error.code}].\n`,
    );
    return 0;
  }
}

async function runDeterministicTests(
  projectRoot: string,
): Promise<number> {
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join("node_modules", "vitest", "vitest.mjs"),
        "run",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return 1;
  } catch (cause: unknown) {
    const error = normalizeError(cause, {
      message: "Deterministic test preflight failed",
    });
    process.stderr.write(
      `Deterministic test preflight failed [${error.code}].\n`,
    );
    return 0;
  }
}

function createHardwareProfile(): string {
  const processors = cpus();
  const memoryGiB = Math.round(totalmem() / (1024 ** 3));
  return [
    process.platform,
    process.arch,
    `${processors.length}cpu`,
    `${memoryGiB}gib`,
  ].join("-");
}

function printReport(
  report: Awaited<ReturnType<typeof runBumblebeeBench>>,
  outputDirectory: string,
): void {
  const score = report.score.score === null
    ? "N/A"
    : report.score.score.toFixed(2);
  const lines = [
    `BumblebeeBench ${report.manifestVersion}`,
    `runId: ${report.runId}`,
    `profile: ${report.profile}`,
    `qualification: ${report.gateEvaluation.status}`,
    `BB score: ${score}`,
    `results: ${outputDirectory}`,
    "",
    ...report.domains.map((domain) =>
      `${domain.domain}: ${domain.score.toFixed(2)} ` +
      `(correctness ${(domain.correctness * 100).toFixed(2)}%, ` +
      `SLO ${(domain.sloCompliance * 100).toFixed(2)}%, ` +
      `p95 ${domain.durationMs.p95.toFixed(3)}ms)`
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run benchmark:1 -- [options]",
      "",
      "Options:",
      "  --profile smoke|full  One or thirty trials per scenario",
      "  --output <directory>   Override the local evidence directory",
      "  --parent-run-id <id>   Link this run to an earlier run",
      "  -h, --help             Show this help",
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
    message: "BumblebeeBench failed",
  });
  process.stderr.write(
    `BumblebeeBench failed [${error.code}]: ${error.message}\n`,
  );
  process.exitCode = 1;
});
